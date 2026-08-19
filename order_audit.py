"""
Order-handling audit — finds unvalidated exchange responses.
Targets the exact bug class that caused naked positions:
- .get("id") without None checks
- placed/success flags set unconditionally
- batch responses indexed without length checks
- success logs ("✓") without prior validation
"""

import re
from pathlib import Path

BOT = Path("bot")

def audit_file(path: Path):
    src = path.read_text(encoding="utf-8")
    lines = src.split("\n")
    findings = []

    for i, line in enumerate(lines, 1):
        # Pattern 1: .get("id") or ["id"] read without validation on same line or next
        m = re.search(r'(\w+)\s*=\s*(\w+)\.get\("id"\)', line)
        if m:
            var = m.group(1)
            # Look ahead 3 lines for a None check
            window = "\n".join(lines[i-1:i+4])
            if f"if not {var}" not in window and f"if {var} is None" not in window and "if not " + var not in window:
                findings.append((i, f"unvalidated order id read: {line.strip()[:90]}"))

        # Pattern 2: unconditional placed/success flags
        if re.search(r'\b(sl_placed|tp_placed|placed|accepted)\s*=\s*True\b', line):
            # Check if inside an if/validation block by looking at indentation context
            # Flag only if the line immediately follows an id read without check
            prev = lines[i-2] if i >= 2 else ""
            findings.append((i, f"unconditional flag set: {line.strip()[:90]}"))

        # Pattern 3: batch result indexed without length check
        if re.search(r'(\w+)\[(\d+)\]\.get\(', line):
            findings.append((i, f"batch index without length check: {line.strip()[:90]}"))

        # Pattern 4: success claim without verification context
        if re.search(r'(placed|protected|SL\+TP|bracketed).*✓', line, re.IGNORECASE):
            # check 3 lines before for a real id validation
            window = "\n".join(lines[max(0,i-5):i])
            if "if not" not in window and "raise" not in window:
                findings.append((i, f"success log without validation: {line.strip()[:90]}"))

        # Pattern 5: exception swallowed then success continues
        if re.search(r'except.*:\s*$', line):
            nxt = "\n".join(lines[i:i+3])
            if "logger.info" in nxt and "✓" in nxt:
                findings.append((i, f"exception followed by success log: {line.strip()[:90]}"))

    return findings

total = 0
for f in sorted(BOT.glob("*.py")):
    if f.name.startswith("test_"):
        continue
    findings = audit_file(f)
    if findings:
        print(f"\n=== {f} — {len(findings)} potential issues ===")
        for line_no, desc in findings:
            print(f"  L{line_no}: {desc}")
        total += len(findings)

print(f"\nTOTAL: {total} potential order-handling issues")

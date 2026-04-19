import os
import re

def fix_file(filepath):
    if not os.path.exists(filepath):
        print(f"Skipping {filepath}, does not exist.")
        return
        
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Change executor.check_position_exit to await executor.check_position_exit
    # Do positive lookbehind/lookahead if needed, or simply string replace:
    content = re.sub(
        r'([ \t]*)(exited,\s*pnl\s*=\s*)executor\.check_position_exit\(',
        r'\1\2await executor.check_position_exit(',
        content
    )

    # In test_trade_execution.py, make section_position_exit async
    content = content.replace("def section_position_exit():", "async def section_position_exit():")
    
    # In main(), await section_position_exit()
    # Find section_position_exit() under Sync tests and move it or just add await if it's there
    content = content.replace("        section_position_exit()", "        await section_position_exit()")

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"Updated {filepath}")

fix_file('c:/Users/pc/Desktop/projects/Quad-desk/test_trade_execution.py')
fix_file('c:/Users/pc/Desktop/projects/Quad-desk/test_integration_e2e.py')

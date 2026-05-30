#!/usr/bin/env python3
"""
Generate a focused PDF document for bot auditing (~80 pages).
Removes non-essential files and redundant documentation.
Focuses on core trading logic and execution flow.
"""

import os
import re
from datetime import datetime
from pathlib import Path

try:
    from reportlab.lib.pagesizes import letter, A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Preformatted, Table, TableStyle
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT, TA_CENTER
except ImportError:
    print("reportlab not found. Installing...")
    os.system("pip install reportlab")
    from reportlab.lib.pagesizes import letter, A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Preformatted, Table, TableStyle
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT, TA_CENTER

BOT_DIR = Path(__file__).parent / "bot"
OUTPUT_PDF = Path(__file__).parent / "BOT_AUDIT_CODE_FOCUSED.pdf"

# Core files for audit (ordered by importance)
CORE_FILES = [
    ("main.py", "Bot Entry Point & Main Loop"),
    ("quant_engine.py", "Quantitative Trading Engine"),
    ("executor.py", "Trade Execution Logic"),
    ("signal_config.py", "Signal Configuration & Parameters"),
    ("ulis_engine.py", "ULIS Strategy Engine"),
    ("data_feed.py", "Market Data Handler"),
    ("derivatives_context.py", "Derivatives Context Manager"),
    ("notifier.py", "Alert & Notification System"),
    ("heartbeat.py", "Heartbeat & Monitoring"),
    ("backtest_hybrid.py", "Backtesting Engine"),
]

def strip_docstrings(content):
    """Remove unnecessary docstrings to reduce PDF size while keeping logic."""
    # Remove triple-quoted docstrings but keep inline comments
    content = re.sub(r'"""[\s\S]*?"""', '', content)
    content = re.sub(r"'''[\s\S]*?'''", '', content)
    return content

def strip_comments(content, keep_critical=True):
    """Remove verbose comments but keep critical ones."""
    lines = content.split('\n')
    filtered = []
    
    for line in lines:
        # Keep lines with critical comments (marked with #!!!, ###, or important keywords)
        stripped = line.strip()
        if stripped.startswith('#!!!') or stripped.startswith('###'):
            filtered.append(line)
        elif '#' in line and any(keyword in line.lower() for keyword in 
              ['critical', 'important', 'warning', 'alert', 'error', 'fix', 'bug', 'todo', 'fixme']):
            filtered.append(line)
        elif not stripped.startswith('#'):
            # Keep non-comment lines
            filtered.append(line)
        elif stripped.startswith('# ') and len(stripped) > 80:
            # Skip very long comment lines
            continue
        else:
            filtered.append(line)
    
    return '\n'.join(filtered)

def compress_code(content):
    """Compress whitespace without removing logic."""
    # Remove excessive blank lines (more than 2 consecutive)
    content = re.sub(r'\n\n\n+', '\n\n', content)
    # Remove trailing whitespace
    content = '\n'.join(line.rstrip() for line in content.split('\n'))
    return content

def clean_code(content):
    """Clean code for audit PDF."""
    content = strip_docstrings(content)
    content = strip_comments(content)
    content = compress_code(content)
    return content.strip()

def create_focused_audit_pdf():
    """Create focused PDF with core bot code for auditing."""
    
    doc = SimpleDocTemplate(
        str(OUTPUT_PDF),
        pagesize=letter,
        rightMargin=0.4*inch,
        leftMargin=0.4*inch,
        topMargin=0.4*inch,
        bottomMargin=0.4*inch,
    )
    
    styles = getSampleStyleSheet()
    
    # Define custom styles - more compact
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=20,
        textColor=colors.HexColor('#1f4788'),
        spaceAfter=3,
        alignment=TA_CENTER,
        fontName='Helvetica-Bold',
    )
    
    section_style = ParagraphStyle(
        'SectionTitle',
        parent=styles['Heading2'],
        fontSize=12,
        textColor=colors.HexColor('#2d5aa8'),
        spaceAfter=2,
        spaceBefore=6,
        fontName='Helvetica-Bold',
        borderColor=colors.HexColor('#cccccc'),
        borderWidth=0.5,
        borderPadding=2,
    )
    
    file_title_style = ParagraphStyle(
        'FileTitle',
        parent=styles['Heading3'],
        fontSize=11,
        textColor=colors.HexColor('#1f4788'),
        spaceAfter=2,
        spaceBefore=8,
        fontName='Helvetica-Bold',
        borderColor=colors.HexColor('#e0e0e0'),
        borderWidth=0.5,
        borderPadding=2,
    )
    
    code_style = ParagraphStyle(
        'Code',
        parent=styles['Normal'],
        fontName='Courier',
        fontSize=7.5,
        leftIndent=0,
        rightIndent=0,
        leading=8,
    )
    
    # Build story
    story = []
    
    # Title page - compact
    story.append(Paragraph("BOT AUDIT CODE REVIEW", title_style))
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        f"<b>Generated:</b> {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}<br/>" +
        f"<b>Focus:</b> Core Trading Logic & Execution<br/>" +
        f"<b>Source:</b> {BOT_DIR}",
        styles['Normal']
    ))
    story.append(Spacer(1, 12))
    story.append(Paragraph("<b>Core Components:</b>", section_style))
    
    files_list = []
    for filename, description in CORE_FILES:
        if (BOT_DIR / filename).exists():
            files_list.append(f"<b>{filename}</b> - {description}")
    
    story.append(Paragraph("<br/>".join(files_list), styles['Normal']))
    story.append(Spacer(1, 12))
    story.append(Paragraph(
        "<font size=9><i>Note: This audit PDF contains core bot logic with optimized formatting " +
        "for readability. Redundant comments and docstrings have been removed.</i></font>",
        styles['Normal']
    ))
    story.append(PageBreak())
    
    # Add table of contents
    story.append(Paragraph("TABLE OF CONTENTS", section_style))
    story.append(Spacer(1, 4))
    toc_items = []
    for idx, (filename, description) in enumerate(CORE_FILES, 1):
        if (BOT_DIR / filename).exists():
            toc_items.append(f"{idx}. {filename} - {description}")
    story.append(Paragraph("<br/>".join(toc_items), styles['Normal']))
    story.append(PageBreak())
    
    # Add each file
    files_found = 0
    for filename, description in CORE_FILES:
        filepath = BOT_DIR / filename
        
        if not filepath.exists():
            print(f"⚠️  File not found: {filename}")
            continue
        
        files_found += 1
        print(f"✓ Processing {filename}")
        
        # File header with description
        story.append(Paragraph(f"📄 {filename}", file_title_style))
        story.append(Paragraph(f"<font size=9><i>{description}</i></font>", styles['Normal']))
        story.append(Spacer(1, 4))
        
        # Read and clean file content
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Clean the code
            cleaned_content = clean_code(content)
            
            # Limit content size to keep PDF to ~80 pages
            if len(cleaned_content) > 150000:
                lines = cleaned_content.split('\n')
                # Keep first 4000 lines of important files
                cleaned_content = '\n'.join(lines[:4000])
                cleaned_content += "\n\n... [CONTENT CONTINUES - SEE FULL SOURCE] ..."
            
            # Add code content
            story.append(Preformatted(cleaned_content, code_style))
        except Exception as e:
            story.append(Paragraph(f"<b>Error reading file:</b> {str(e)}", styles['Normal']))
        
        story.append(PageBreak())
    
    # Build PDF
    print(f"\n📝 Building focused audit PDF...")
    doc.build(story)
    
    print(f"✅ Focused audit PDF created!")
    print(f"📁 Location: {OUTPUT_PDF}")
    print(f"📊 Files included: {files_found}/{len(CORE_FILES)}")
    return OUTPUT_PDF

if __name__ == "__main__":
    create_focused_audit_pdf()

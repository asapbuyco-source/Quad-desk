#!/usr/bin/env python3
"""
Generate a PDF document containing all bot source code for auditing.
"""

import os
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
OUTPUT_PDF = Path(__file__).parent / "BOT_AUDIT_CODE.pdf"

# Python files to include (in order)
PYTHON_FILES = [
    "requirements.txt",
    "__init__.py",
    "signal_config.py",
    "data_feed.py",
    "derivatives_context.py",
    "heartbeat.py",
    "ulis_engine.py",
    "executor.py",
    "notifier.py",
    "main.py",
    "quant_engine.py",
    "backtest_hybrid.py",
    "verify_region.py",
]

def create_audit_pdf():
    """Create PDF with all bot code files."""
    
    doc = SimpleDocTemplate(
        str(OUTPUT_PDF),
        pagesize=letter,
        rightMargin=0.5*inch,
        leftMargin=0.5*inch,
        topMargin=0.5*inch,
        bottomMargin=0.5*inch,
    )
    
    styles = getSampleStyleSheet()
    
    # Define custom styles
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=24,
        textColor=colors.HexColor('#1f4788'),
        spaceAfter=6,
        alignment=TA_CENTER,
        fontName='Helvetica-Bold',
    )
    
    file_title_style = ParagraphStyle(
        'FileTitle',
        parent=styles['Heading2'],
        fontSize=14,
        textColor=colors.HexColor('#2d5aa8'),
        spaceAfter=4,
        spaceBefore=12,
        fontName='Helvetica-Bold',
        borderColor=colors.HexColor('#cccccc'),
        borderWidth=1,
        borderPadding=4,
        borderRadius=2,
    )
    
    code_style = ParagraphStyle(
        'Code',
        parent=styles['Normal'],
        fontName='Courier',
        fontSize=8,
        leftIndent=0,
        rightIndent=0,
        leading=9,
    )
    
    # Build story
    story = []
    
    # Title page
    story.append(Paragraph("BOT AUDIT CODE REVIEW", title_style))
    story.append(Spacer(1, 12))
    story.append(Paragraph(
        f"<b>Generated:</b> {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        styles['Normal']
    ))
    story.append(Paragraph(
        f"<b>Source Directory:</b> {BOT_DIR}",
        styles['Normal']
    ))
    story.append(Spacer(1, 24))
    story.append(Paragraph(
        "<b>Contents:</b><br/>" + 
        "<br/>".join([f"• {f}" for f in PYTHON_FILES if (BOT_DIR / f).exists()]),
        styles['Normal']
    ))
    story.append(PageBreak())
    
    # Add each file
    files_found = 0
    for filename in PYTHON_FILES:
        filepath = BOT_DIR / filename
        
        if not filepath.exists():
            print(f"⚠️  File not found: {filename}")
            continue
        
        files_found += 1
        print(f"✓ Adding {filename}")
        
        # File header
        story.append(Paragraph(f"📄 {filename}", file_title_style))
        
        # Read file content
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Limit content for very large files
            if len(content) > 100000:
                content = content[:100000] + "\n\n... [FILE TRUNCATED - TOO LARGE] ..."
            
            # Add code content
            story.append(Preformatted(content, code_style))
        except Exception as e:
            story.append(Paragraph(f"<b>Error reading file:</b> {str(e)}", styles['Normal']))
        
        story.append(PageBreak())
    
    # Build PDF
    print(f"\n📝 Building PDF...")
    doc.build(story)
    
    print(f"✅ PDF created successfully!")
    print(f"📁 Location: {OUTPUT_PDF}")
    print(f"📊 Files included: {files_found}/{len(PYTHON_FILES)}")
    return OUTPUT_PDF

if __name__ == "__main__":
    create_audit_pdf()

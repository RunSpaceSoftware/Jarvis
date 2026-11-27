import sys, os, re, zipfile, zlib, html
from xml.etree import ElementTree as ET

LIMIT = 20000

def local(tag):
    return tag.rsplit('}', 1)[-1]

def clean(text):
    text = html.unescape(text or '')
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n[ \t]+', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

def xml_text(data):
    root = ET.fromstring(data)
    out = []
    for el in root.iter():
        name = local(el.tag)
        if name == 't' and el.text:
            out.append(el.text)
        elif name in ('tab', 'br'):
            out.append('\n' if name == 'br' else '\t')
        elif name == 'p':
            out.append('\n')
    return clean(''.join(out))

def docx(path):
    with zipfile.ZipFile(path) as z:
        data = z.read('word/document.xml')
    return xml_text(data)

def pptx(path):
    with zipfile.ZipFile(path) as z:
        names = sorted([n for n in z.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)], key=lambda n: int(re.search(r'(\d+)', n).group(1)))
        return '\n\n'.join('Slide ' + str(i + 1) + ':\n' + xml_text(z.read(n)) for i, n in enumerate(names))

def xlsx(path):
    with zipfile.ZipFile(path) as z:
        shared = []
        if 'xl/sharedStrings.xml' in z.namelist():
            root = ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in root.iter():
                if local(si.tag) == 'si':
                    shared.append(''.join(t.text or '' for t in si.iter() if local(t.tag) == 't'))
        sheets = sorted([n for n in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml$', n)])
        out = []
        for sheet in sheets:
            out.append('Sheet: ' + sheet.rsplit('/', 1)[-1])
            root = ET.fromstring(z.read(sheet))
            for row in root.iter():
                if local(row.tag) != 'row':
                    continue
                cells = []
                for c in row:
                    if local(c.tag) != 'c':
                        continue
                    t = c.attrib.get('t')
                    v = next((x.text or '' for x in c if local(x.tag) == 'v'), '')
                    if t == 's' and v.isdigit() and int(v) < len(shared):
                        v = shared[int(v)]
                    elif t == 'inlineStr':
                        v = ''.join(x.text or '' for x in c.iter() if local(x.tag) == 't')
                    cells.append(v)
                if any(cells):
                    out.append('\t'.join(cells))
            out.append('')
        return '\n'.join(out)

def pdf_fallback(path):
    raw = open(path, 'rb').read()
    chunks = []
    for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', raw, re.S):
        data = m.group(1)
        try:
            data = zlib.decompress(data)
        except Exception:
            pass
        text = data.decode('latin-1', 'ignore')
        for s in re.finditer(r'\((?:\\.|[^\\()])*\)', text):
            value = s.group(0)[1:-1]
            value = re.sub(r'\\([nrtbf()\\])', lambda x: {'n': '\n', 'r': '\r', 't': '\t', 'b': '\b', 'f': '\f'}.get(x.group(1), x.group(1)), value)
            value = re.sub(r'\\([0-7]{1,3})', lambda x: chr(int(x.group(1), 8)), value)
            if value.strip():
                chunks.append(value)
    return clean(' '.join(chunks))

def pdf(path):
    errors = []
    for module in ('pypdf', 'PyPDF2'):
        try:
            mod = __import__(module)
            reader = mod.PdfReader(path)
            text = '\n\n'.join((page.extract_text() or '') for page in reader.pages)
            if text.strip():
                return clean(text)
        except Exception as e:
            errors.append(module + ': ' + str(e))
    text = pdf_fallback(path)
    if text.strip():
        return text
    raise RuntimeError('No text extracted. This may be a scanned PDF. Install pypdf for better extraction: pip install pypdf')

def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: docs.py <file>')
    path = sys.argv[1]
    if not os.path.isfile(path):
        raise SystemExit('File not found: ' + path)
    ext = os.path.splitext(path)[1].lower()
    if ext == '.docx':
        text = docx(path)
    elif ext == '.pptx':
        text = pptx(path)
    elif ext in ('.xlsx', '.xlsm'):
        text = xlsx(path)
    elif ext == '.pdf':
        text = pdf(path)
    else:
        raise SystemExit('Unsupported document type: ' + ext)
    if not text.strip():
        raise SystemExit('No text found in ' + os.path.basename(path))
    sys.stdout.write(text[:LIMIT])
    if len(text) > LIMIT:
        sys.stdout.write('\n...[truncated ' + str(len(text) - LIMIT) + ' chars]')

if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print('ERROR: ' + str(e), file=sys.stderr)
        sys.exit(1)

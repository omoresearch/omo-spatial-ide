#!/usr/bin/env python3
# Measures the Store text blocks in listing.md against Meta's limits. Quoted blocks ("> ") are the Store text.
import re, pathlib, sys
md = pathlib.Path(__file__).with_name('listing.md').read_text()
def block(title):
    sec = re.search(r'^## ' + re.escape(title) + r'.*?\n(.*?)(?=^## |\Z)', md, re.S | re.M).group(1)
    lines = [l[2:] if l.startswith('> ') else '' for l in sec.split('\n') if l.startswith('>')]
    text = '\n'.join(lines).strip()
    return re.sub(r'(?<!\n)\n(?!\n)', ' ', text)   # wrapped lines join with a space; blank lines stay paragraph breaks
ok = True
for title, lim in [('3. Short description', 500), ('4. Long description', 1500), ('8. Early Access note', 1500)]:
    t = block(title); n = len(t); ok &= n <= lim
    print(f'{title}: {n}/{lim} {"OK" if n <= lim else "OVER"}')
names = ['Omo Space', 'Omo Space: Agent Desk', 'Omo Space: Terminals in VR']
for n in names: print(f'name "{n}": {len(n)}/40 {"OK" if len(n) <= 40 else "OVER"}'); ok &= len(n) <= 40
kw = re.findall(r'^\d\. (\S+)$', re.search(r'## 5\..*?\n(.*?)\n\n', md, re.S).group(1), re.M)
print('keywords:', kw, 'count', len(kw), 'OK' if len(kw) <= 5 and all(len(k) <= 50 and ' ' not in k for k in kw) else 'BAD')
ok &= len(kw) <= 5
print('ALL WITHIN LIMITS' if ok else 'LIMIT EXCEEDED'); sys.exit(0 if ok else 1)

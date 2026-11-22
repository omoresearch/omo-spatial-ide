import sys,glob
from PIL import Image
pat,out,cols,tw=sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4])
fs=sorted(glob.glob(pat)); ims=[Image.open(f).convert("RGB") for f in fs]
w,h=ims[0].size; th=int(h*tw/w); rows=(len(ims)+cols-1)//cols
S=Image.new("RGB",(cols*tw+(cols+1)*6,rows*th+(rows+1)*6),(40,40,40))
for i,im in enumerate(ims):
    S.paste(im.resize((tw,th),Image.LANCZOS),(6+(i%cols)*(tw+6),6+(i//cols)*(th+6)))
S.save(out,quality=88); print(out,S.size,len(ims))

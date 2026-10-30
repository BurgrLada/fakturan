import os, math, functools, io
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform
FD=os.path.join(os.path.dirname(__file__),'fonts')
@functools.lru_cache(None)
def load(name, axes=()):
    f=TTFont(f'{FD}/{name}.ttf')
    if axes: f=instancer.instantiateVariableFont(f,dict(axes))
    b=io.BytesIO(); f.save(b); data=b.getvalue()
    return TTFont(io.BytesIO(data)), hb.Font(hb.Face(data))
def shape(name,text,axes=()):
    tt,hf=load(name,tuple(sorted(axes)))
    buf=hb.Buffer(); buf.add_str(text); buf.guess_segment_properties()
    hb.shape(hf,buf,{'kern':True,'liga':False})
    order=tt.getGlyphOrder()
    return tt,[(order[i.codepoint],p.x_advance,p.x_offset,p.y_offset) for i,p in zip(buf.glyph_infos,buf.glyph_positions)]
def text(name,s,size,x=0,y=0,track=0,axes=()):
    """Returns (path d, advance width); y is the baseline, track in em/1000."""
    tt,run=shape(name,s,axes); gs=tt.getGlyphSet(); k=size/tt['head'].unitsPerEm
    pen=SVGPathPen(gs,ntos=lambda v:f'{v:.2f}'.rstrip('0').rstrip('.')); cx=x
    for g,adv,ox,oy in run:
        gs[g].draw(TransformPen(pen,(k,0,0,-k,cx+ox*k,y-oy*k)))
        cx+=adv*k+track*size/1000
    return pen.getCommands(),cx-x-track*size/1000
def on_circle(name,s,size,cx,cy,r,start,track=0,axes=()):
    """Glyphs set clockwise around a circle, baseline on r, start in degrees from 12 o'clock."""
    tt,run=shape(name,s,axes); gs=tt.getGlyphSet(); k=size/tt['head'].unitsPerEm
    pen=SVGPathPen(gs,ntos=lambda v:f'{v:.2f}'.rstrip('0').rstrip('.')); a=math.radians(start)
    for g,adv,_,_ in run:
        w=adv*k; mid=a+w/2/r
        t=Transform().translate(cx+r*math.sin(mid),cy-r*math.cos(mid)).rotate(mid).scale(k,-k).translate(-adv/2,0)
        gs[g].draw(TransformPen(pen,t))
        a+=(w+track*size/1000)/r
    return pen.getCommands(),math.degrees(a)-start
from fontTools.pens.boundsPen import BoundsPen
def centered(name,s,size,cx,cy,axes=()):
    """Path of s with its ink box centred on (cx,cy)."""
    tt,run=shape(name,s,axes); gs=tt.getGlyphSet(); k=size/tt['head'].unitsPerEm
    bp=BoundsPen(gs); x=0
    for g,adv,_,_ in run:
        gs[g].draw(TransformPen(bp,(1,0,0,1,x,0))); x+=adv
    a,b,c,d=bp.bounds
    d_,_w=text(name,s,size,cx-(a+c)/2*k,cy+(b+d)/2*k,axes=axes)
    return d_

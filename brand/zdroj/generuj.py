import os, sys
sys.path.insert(0,os.path.dirname(__file__))
from lib import text, centered
OUT=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..')
INK,ONDARK,URAN='#1E1A1C','#F7F4EE','#C6EC3E'
SG=(('wght',700),); S=74; FS=66; CAP_MID=37; BASE=60
def rr(x,y,s,r): return f'M{x+r} {y}H{x+s-r}A{r} {r} 0 0 1 {x+s} {y+r}V{y+s-r}A{r} {r} 0 0 1 {x+s-r} {y+s}H{x+r}A{r} {r} 0 0 1 {x} {y+s-r}V{y+r}A{r} {r} 0 0 1 {x+r} {y}Z'
def glyphs(x,y,s):
    return centered('SpaceGrotesk','U',s*.66,x+s/2,y+s*.57,SG), text('SpaceMono-Bold','92',s*.2,x+s*.09,y+s*.24)[0]
def svg(w,h,b,extra=''): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.1f} {h}" role="img" aria-label="Fakturan"{extra}><title>Fakturan</title>{b}</svg>\n'
def word():
    a,w=text('SpaceGrotesk','fakt',FS,0,BASE,axes=SG); x=w+5
    b,w2=text('SpaceGrotesk','ran',FS,x+S+6,BASE,axes=SG)
    return a,b,x,x+S+6+w2
a,b,x,W=word(); u,n=glyphs(x,0,S)
def full(fg,tile=URAN,tx=INK): return svg(W,S,f'<path d="{a}{b}" fill="{fg}"/><rect x="{x:.2f}" width="{S}" height="{S}" rx="6.6" fill="{tile}"/><path d="{u}{n}" fill="{tx}"/>')
w=lambda f,s:open(f'{OUT}/{f}','w').write(s)
w('logo.svg',full(INK)); w('logo-dark.svg',full(ONDARK))
w('logo-mono.svg',svg(W,S,f'<path d="{a}{b}" fill="currentColor"/><path fill="currentColor" fill-rule="evenodd" d="{rr(round(x,2),0,S,6.6)}{u}{n}"/>'))
u2,n2=glyphs(0,0,32)
icon=svg(32,32,f'<rect width="32" height="32" rx="6" fill="{URAN}"/><path d="{centered("SpaceGrotesk","U",23,16,19,SG)}{text("SpaceMono-Bold","92",8,3,8.5)[0]}" fill="{INK}"/>')
w('icon.svg',icon); w('favicon.svg',icon)

w('apple-touch-icon.svg',svg(32,32,f'<rect width="32" height="32" fill="{URAN}"/><path d="{centered("SpaceGrotesk","U",19,16,18,SG)}{text("SpaceMono-Bold","92",6.5,6,10)[0]}" fill="{INK}"/>'))

from PIL import ImageFont

# EMU -> points: 1 inch = 914400 EMU = 72 pt
EMU_PER_PT = 914400.0 / 72.0

# Slide geometry (EMU)
slide_cx = 12191695
slide_cy = 6858000

# Title TextBox 2
title_off = (548640, 320040)
title_ext = (11064240, 822960)
# Body TextBox 3
body_off = (640080, 1371600)
body_ext = (5120640, 4937760)
# Chart GraphicFrame
chart_off = (6035040, 1371600)
chart_ext = (5577840, 4846320)

def emu_to_pt(v):
    return v / EMU_PER_PT

title_text = "记忆层:数据安全与三层保底"
body_lines = [
    "• WAL 先持久再可见,崩溃后 21/21 全部可查到",
    "• 快照原子回滚:O(1) 指针,毫秒级视图切换",
    "• 任务队列:SIGKILL 后意图与上下文完整找回",
    "• recall_floor:可配置召回下限 85-100%",
]

# Use a CJK font for measurement (PingFang SC / STHeiti). CJK glyphs ~1em full width.
font_paths = [
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/Users/fun10165/Library/Fonts/FandolHei-Bold.otf",
]

def try_font(path, size):
    try:
        return ImageFont.truetype(path, size, index=0)
    except Exception as e:
        return None

font_cjk = None
for p in font_paths:
    f = try_font(p, 18)
    if f is not None:
        font_cjk = f
        cjk_path = p
        break

print("Using CJK font:", cjk_path)

def text_width_pt(text, font):
    # use getbbox for more accurate width
    bbox = font.getbbox(text)
    return bbox[2] - bbox[0]

# Title at 32pt
ft = try_font(cjk_path, 32)
print("\n=== TITLE (32pt bold) ===")
tw = text_width_pt(title_text, ft)
box_w = emu_to_pt(title_ext[0])
print(f"title text width = {tw:.1f} pt ; box width = {box_w:.1f} pt ({emu_to_pt(title_ext[0])/72:.2f} in) ; fits={tw <= box_w}")

print("\n=== BODY (18pt) ===")
box_w = emu_to_pt(body_ext[0])
box_h = emu_to_pt(body_ext[1])
print(f"body box width = {box_w:.1f} pt ({box_w/72:.2f} in), height = {box_h:.1f} pt ({box_h/72:.2f} in)")
# default text inset 91440 EMU each side
inset = emu_to_pt(91440)
usable_w = box_w - 2*inset
print(f"default inset = {inset:.1f} pt each side; usable width = {usable_w:.1f} pt")
for line in body_lines:
    lw = text_width_pt(line, font_cjk)
    print(f"  [{line}]  width={lw:.1f} pt ({lw/72:.2f} in)  fits_one_line={lw <= usable_w}")

# line height ~1.2 * font size
print(f"\n4 lines at 18pt * ~1.2 line-height = {4*18*1.2:.1f} pt needed vs box height {box_h:.1f} pt -> plenty")

print("\n=== OVERLAP (EMU) ===")
def box(off, ext):
    x0,y0 = off; x1 = x0+ext[0]; y1 = y0+ext[1]
    return (x0,y0,x1,y1)
t = box(title_off, title_ext)
b = box(body_off, body_ext)
c = box(chart_off, chart_ext)
print(f"title box x[{t[0]},{t[2]}] y[{t[1]},{t[3]}]")
print(f"body  box x[{b[0]},{b[2]}] y[{b[1]},{b[3]}]")
print(f"chart box x[{c[0]},{c[2]}] y[{c[1]},{c[3]}]")
print(f"title vs body vertical overlap: title_bottom={t[3]} body_top={b[1]} -> overlap={t[3] > b[1]}")
print(f"body vs chart horizontal overlap: body_right={b[2]} chart_left={c[0]} -> overlap={b[2] > c[0]}")
print(f"title vs chart vertical overlap: title_bottom={t[3]} chart_top={c[1]} -> overlap={t[3] > c[1]}")
# within slide?
print(f"all within slide cx={slide_cx} cy={slide_cy}: title_right={t[2]}<=slide_cx, chart_right={c[2]}<=slide_cx, body_bottom={b[3]}<=slide_cy, chart_bottom={c[3]}<=slide_cy")
print(f"  title_right={t[2]} (slide {slide_cx}) margin={slide_cx-t[2]} EMU")
print(f"  chart_right={c[2]} (slide {slide_cx}) margin={slide_cx-c[2]} EMU")
print(f"  body_bottom={b[3]} chart_bottom={c[3]} (slide {slide_cy})")

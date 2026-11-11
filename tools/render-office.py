"""사무실 모드에 쓸 아이소메트릭 스프라이트를 Blender로 렌더한다.

사용법:
  blender -b --factory-startup --python tools/render-office.py -- <에셋 폴더> <출력 폴더> [--sample]

  <에셋 폴더>  Office_48_Standalone_Pack, Lowpoly_People_Standalone_Pack을 각각 office/, people/에 푼 폴더
  <출력 폴더>  office/mods/office/sprites

워크트리 테이블 하나 = 4인 벤치 책상(05_Four_Person_Bench). 층으로 나눠 렌더해 모드가 겹쳐 그린다.
  table.png                 책상 + 모니터·키보드 (항상)
  seat<i>_empty.png         i번 자리의 빈 의자 (테이블에 가려지는 부분은 투명: holdout)
  seat<i>_<캐릭터>.png       i번 자리의 의자 + 앉아 타이핑하는 사람 (holdout 같음)
  manifest.json             캔버스 크기, 월드 원점 픽셀, 자리별 머리 위치, 테이블 클릭 영역

모든 층은 같은 카메라·같은 캔버스라서, 모드는 같은 좌표에 그대로 겹치면 된다.
그림자는 렌더하지 않는다(투명 배경). 패키지의 스크립트는 실행하지 않고 GLB만 가져온다.
"""
import json
import math
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
ASSETS, OUT = args[0], args[1]
SAMPLE = "--sample" in args
OFFICE = os.path.join(ASSETS, "office", "exports")
PEOPLE = os.path.join(ASSETS, "people", "exports")
os.makedirs(OUT, exist_ok=True)

SIZE = 512          # 캔버스(px). 화면에는 이보다 작게 그린다.
ORTHO = 4.6         # 캔버스 가로가 담는 미터
CAM_ROT = (60, 0, 45)
TARGET = Vector((0, 0, 0.45))   # 캔버스 가운데에 올 월드 점
POSE, POSE_FRAME = "Type", 17
CELL_X, CELL_Y = 3.6, 4.2     # 바닥 한 칸(m): 테이블 2.8×1.4 + 양쪽 자리 + 통로
# 구역을 꾸미는 소품: 이름 → (GLB, 회전)
PROP_SPRITES = {
    "plant": ("46_Indoor_Plant", 0), "cabinet": ("27_Low_Cabinet", 90), "water": ("40_Water_Dispenser", 90),
    "whiteboard": ("20_Mobile_Whiteboard", 0), "bookcase": ("25_Open_Bookcase", 0), "bin": ("48_Waste_Bin", 0),
}

# 자리: (x, y, 회전). 칸막이 기준 양쪽에 두 명씩, 책상 앞 모서리에서 0.4m 떨어져 책상을 바라본다.
SEATS = [(-0.7, -1.1, 180), (0.7, -1.1, 180), (-0.7, 1.1, 0), (0.7, 1.1, 0)]  # 회전 180 = +y(책상 쪽)를 봄
# 테이블 위 소품: 자리마다 모니터(칸막이 쪽)와 키보드
PROPS = []
for x, y, r in SEATS:
    s = -1 if y < 0 else 1
    PROPS.append(("41_Monitor", (x, s * 0.2, 0.762), r))
    PROPS.append(("43_Keyboard", (x, s * 0.5, 0.762), r))

# 앉아 타이핑할 수 있는 성인 위주로 다양하게(성별·피부톤·머리 모양).
CHARACTERS = [
    "P025_young_M_tone1", "P028_young_F_tone2", "P030_young_F_tone3", "P031_young_M_tone4",
    "P034_young_F_tone5", "P035_young_M_tone6", "P038_adult_F_tone1", "P039_adult_M_tone2",
    "P042_adult_F_tone3", "P045_adult_M_tone5", "P048_adult_F_tone6", "P049_middle_M_tone1",
]
if SAMPLE:
    CHARACTERS = CHARACTERS[:3]


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    sc.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in engines else "BLENDER_EEVEE_NEXT"
    sc.render.film_transparent = True
    sc.render.resolution_x = sc.render.resolution_y = SIZE
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.view_settings.view_transform = "Standard"
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = ORTHO
    cam.rotation_euler = tuple(math.radians(v) for v in CAM_ROT)
    back = Vector((0, 0, 1))
    back.rotate(cam.rotation_euler)
    cam.location = TARGET + back * 30
    cam.data.clip_end = 100
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sc.collection.objects.link(sun)
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(40), math.radians(10), math.radians(-30))
    world = bpy.data.worlds.new("W")
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.8, 0.82, 0.85, 1)
    bg.inputs[1].default_value = 0.9
    return sc, cam


def place(path, loc, rotz=0):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        if o.name.startswith("Icosphere"):   # 사람 GLB에 딸려 오는 손 소켓 표시용 구
            bpy.data.objects.remove(o)
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        if o.parent is None:
            o.location = loc
            o.rotation_mode = "XYZ"
            o.rotation_euler = (0, 0, math.radians(rotz))
    return new


def table():
    objs = place(os.path.join(OFFICE, "05_Four_Person_Bench.glb"), (0, 0, 0))
    for name, loc, r in PROPS:
        objs += place(os.path.join(OFFICE, name + ".glb"), loc, r)
    return objs


def pose(objs):
    rig = next(o for o in objs if o.type == "ARMATURE")
    names = [a.name for a in bpy.data.actions]
    act = next((a for a in bpy.data.actions if a.name == POSE), None) or next(a for a in bpy.data.actions if a.name.endswith("_" + POSE) or a.name.startswith(POSE))
    print("POSE", rig.name, act.name, "of", names)
    ad = rig.animation_data_create()
    # glTF 가져오기는 다른 동작들을 NLA 트랙으로 남긴다. 섞이지 않게 모두 끈다.
    for tr in list(ad.nla_tracks):
        ad.nla_tracks.remove(tr)
    ad.action = act
    if getattr(act, "slots", None) and hasattr(rig.animation_data, "action_slot"):
        rig.animation_data.action_slot = act.slots[0]
    bpy.context.scene.frame_set(POSE_FRAME)
    return rig


def render(sc, name):
    sc.render.filepath = os.path.join(OUT, name)
    bpy.ops.render.render(write_still=True)


def px(sc, cam, p):
    v = world_to_camera_view(sc, cam, Vector(p))
    return [round(v.x * SIZE, 1), round((1 - v.y) * SIZE, 1)]


manifest = {"size": SIZE, "ortho": ORTHO, "camera": CAM_ROT, "characters": CHARACTERS, "seats": []}

# 1) 테이블
sc, cam = reset()
objs = table()
render(sc, "table.png")
manifest["origin"] = px(sc, cam, (0, 0, 0))
# 월드 1m가 화면에서 움직이는 픽셀(x축, y축). 모드가 테이블을 배치할 때 쓴다.
o = manifest["origin"]
manifest["ex"] = [a - b for a, b in zip(px(sc, cam, (1, 0, 0)), o)]
manifest["ey"] = [a - b for a, b in zip(px(sc, cam, (0, 1, 0)), o)]
# 바닥 한 칸(테이블 하나 + 네 자리 + 통로)과 그 칸을 덮는 마름모 타일. svg는 글자색으로 칠해지므로 구역마다 색을 바꿀 수 있다.
manifest["cell"] = [CELL_X, CELL_Y]
quad = [px(sc, cam, (x, y, 0)) for x, y in ((-CELL_X / 2, -CELL_Y / 2), (CELL_X / 2, -CELL_Y / 2), (CELL_X / 2, CELL_Y / 2), (-CELL_X / 2, CELL_Y / 2))]
# 칸이 캔버스보다 넓을 수 있어 타일은 자기 범위(floor: x, y, w, h — 캔버스 좌표)로 따로 둔다.
fx, fy = min(q[0] for q in quad), min(q[1] for q in quad)
fw, fh = max(q[0] for q in quad) - fx, max(q[1] for q in quad) - fy
manifest["floor"] = [round(fx, 1), round(fy, 1), round(fw, 1), round(fh, 1)]
with open(os.path.join(OUT, "floor.svg"), "w") as f:
    pts = " ".join(f"{round(x - fx, 1)},{round(y - fy, 1)}" for x, y in quad)
    f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {round(fw, 1)} {round(fh, 1)}"><polygon points="{pts}" fill="#000"/></svg>\n')
# 클릭 영역: 테이블과 네 자리를 감싸는 바닥 사각형의 화면 범위
corners = [px(sc, cam, (x, y, z)) for x in (-1.5, 1.5) for y in (-1.6, 1.6) for z in (0, 1.25)]
manifest["hit"] = [min(c[0] for c in corners), min(c[1] for c in corners), max(c[0] for c in corners), max(c[1] for c in corners)]
# 겹쳐 그리는 순서: 화면에서 멀리 있는 자리(카메라 쪽에서 먼 것)부터
manifest["order"] = sorted(range(len(SEATS)), key=lambda i: px(sc, cam, (SEATS[i][0], SEATS[i][1], 0))[1])

# 바닥 칸의 네 변(구역 바깥 테두리용). 구역 가장자리 칸에만 그 쪽 변을 그린다. 이름은 월드 방향.
edges = {"xmin": (quad[0], quad[3]), "xmax": (quad[1], quad[2]), "ymin": (quad[0], quad[1]), "ymax": (quad[3], quad[2])}
for side, (a, b) in edges.items():
    with open(os.path.join(OUT, f"edge_{side}.svg"), "w") as f:
        f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {round(fw, 1)} {round(fh, 1)}">'
                f'<line x1="{round(a[0] - fx, 1)}" y1="{round(a[1] - fy, 1)}" x2="{round(b[0] - fx, 1)}" y2="{round(b[1] - fy, 1)}" '
                f'stroke="#000" stroke-width="5" stroke-linecap="round"/></svg>\n')

# 소품: 구역 가장자리에 둔다. 모두 월드 원점에 렌더하고, 모드가 원하는 월드 위치로 옮겨 겹친다.
manifest["props"] = {}
for key, (glb, rot) in PROP_SPRITES.items():
    sc, cam = reset()
    objs = place(os.path.join(OFFICE, glb + ".glb"), (0, 0, 0), rot)
    render(sc, f"prop_{key}.png")
    bpy.context.view_layer.update()
    pts = [px(sc, cam, o.matrix_world @ Vector(c)) for o in objs if o.type == "MESH" for c in o.bound_box]
    manifest["props"][key] = {"top": min(p[1] for p in pts), "bottom": max(p[1] for p in pts)}

# 2) 자리마다: 빈 의자, 그리고 캐릭터별 의자 + 사람. 테이블은 holdout으로 남겨 가려지는 부분을 지운다.
for i, (x, y, r) in enumerate(SEATS):
    sc, cam = reset()
    for o in table():
        o.is_holdout = True
    place(os.path.join(OFFICE, "09_Task_Chair.glb"), (x, y, 0), r)
    render(sc, f"seat{i}_empty.png")
    head = None
    for ch in CHARACTERS:
        person = place(os.path.join(PEOPLE, ch + ".glb"), (x, y, 0), r)
        rig = pose(person)
        bpy.context.view_layer.update()
        if head is None:
            hb = rig.pose.bones["head"]
            head = px(sc, cam, rig.matrix_world @ hb.tail)
        render(sc, f"seat{i}_{ch}.png")
        for o in person:
            bpy.data.objects.remove(o, do_unlink=True)
        for a in list(bpy.data.actions):
            bpy.data.actions.remove(a)
    manifest["seats"].append({"pos": [x, y, r], "head": head, "floor": px(sc, cam, (x, y, 0))})

with open(os.path.join(OUT, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
print("RENDERED", len(CHARACTERS), "characters to", OUT)

# -*- coding: utf-8 -*-
"""ComfyUI_ZWNLOVE - 变量轮询节点包

ZWNLOVE_VariablePool  变量池：
  模式 = 词条模式（一行一条）/ 提示词模式（[ ... ] 包一段，段内可换行）
  取值方式 = 顺序（按运行次数轮询，到末行锁住）/ 随机（每次随机抽一条）
  输出：变量（给引用节点用，保留完整原文）、当前值（清洗 + 截到「当前值字数」，
  默认 6 个字，适合直接接 SaveImage.filename_prefix；不要拿它接 CLIP 当提示词）

ZWNLOVE_VariableRef   变量引用：
  模板里写 {动物} / {环境} / {提示词}，由最多 12 个变量输入动态替换，输出 STRING

用法：变量池 -> 变量引用 -> CLIPTextEncode.text
运行按钮旁的次数填 N，就依次出第 1..N 条。
"""

import hashlib
import random
import re
import threading

VAR_TYPE = "ZWNLOVE_VAR"
MAX_VARS = 12

# unique_id -> {"sig", "cursor", "start", "total"}；游标是唯一真相，只在后端保存
_STATE = {}
_LOCK = threading.Lock()
_TICK = 0

try:
    from aiohttp import web
    from server import PromptServer
    _HAS_SERVER = True
except Exception:  # 降级：没有 server 时节点仍能跑，只是重置按钮的接口不可用
    _HAS_SERVER = False


def _parse_items(text, mode):
    """词条模式按换行分；提示词模式按 [ ... ] 分段，段内换行完整保留。"""
    s = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    if mode == "提示词模式":
        return [m.strip() for m in re.findall(r"\[([\s\S]*?)\]", s) if m.strip()]
    return [ln.strip() for ln in s.split("\n") if ln.strip()]


# Windows 文件名非法字符 + 所有控制字符（含换行、制表符）
_BAD_FILENAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')


def _short_value(text, limit):
    """「当前值」输出口专用：洗掉不能进文件名的字符，再截到最多 limit 个字。
    只作用于这根输出线；var["value"] 始终保留完整原文，主提示词不受影响。"""
    s = _BAD_FILENAME.sub(" ", str(text or ""))
    s = re.sub(r"\s+", " ", s).strip()
    s = s[:max(1, int(limit))]
    return s.rstrip(". ").strip()


def _next_tick():
    """每次缓存检查都返回新值，强制节点重算，绕开 ComfyUI 的节点结果缓存。"""
    global _TICK
    with _LOCK:
        _TICK += 1
        return _TICK


class ZWNLOVE_VariablePool:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模式": (["词条模式", "提示词模式"],),
                "取值方式": (["顺序", "随机"],),
                "开始序号": ("INT", {"default": 1, "min": 1, "max": 999999, "step": 1}),
                "变量名称": ("STRING", {"default": "动物"}),
                "词条列表": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "词条模式：一行一个；提示词模式：用 [ ... ] 包住每一段",
                }),
                "当前值字数": ("INT", {"default": 6, "min": 1, "max": 999, "step": 1}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (VAR_TYPE, "STRING")
    RETURN_NAMES = ("变量", "当前值")
    FUNCTION = "run"
    CATEGORY = "ZWNLOVE/变量"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return _next_tick()

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def run(self, 模式, 取值方式, 开始序号, 变量名称, 词条列表,
            当前值字数=6, unique_id=None, **kwargs):
        items = _parse_items(词条列表, 模式)
        total = len(items)
        start = max(1, int(开始序号))
        is_random = str(取值方式) == "随机"
        key = str(unique_id) if unique_id is not None else "pool"

        # 内容 / 变量名 / 开始序号 / 模式 / 取值方式 任一变化 => 自动回到起始条。
        # 注意：开始序号同时是「实时序号框」，前端每次执行后会把它同步成 next_index。
        # 新一次递交时 sig 因 start 变化而重置，重置目标恰好就是下一条，等同于续跑；
        # 用户手动改这个数字递交时，同样走这条路径，实现「从第 N 条跳转」。
        # 同一批 N 次队列里 prompt 是冻结的（start 不变），因此批内不会重复重置。
        sig = hashlib.md5(
            ("\n".join(items) + "\0" + str(变量名称) + "\0" + str(start)
             + "\0" + str(模式) + "\0" + str(取值方式)).encode("utf-8")
        ).hexdigest()

        with _LOCK:
            st = _STATE.get(key)
            if st is None or st.get("sig") != sig:
                st = {"sig": sig, "cursor": None, "start": start, "total": total}
                _STATE[key] = st
            st["total"] = total
            st["start"] = start

            idx = 0
            next_index = 1
            if total == 0:
                value, progress = "", "0/0"
                st["cursor"] = None
            elif is_random:
                idx = random.randrange(total)
                value = items[idx]
                progress = "随机 {}/{}".format(idx + 1, total)
                st["cursor"] = None  # 随机不走顺序游标
                next_index = 0      # 随机模式不回写「开始序号」
            else:
                if st["cursor"] is None:
                    idx = min(start - 1, total - 1)
                else:
                    idx = min(int(st["cursor"]), total - 1)
                value = items[idx]
                progress = "{}/{}".format(idx + 1, total)
                # 到末条锁住：不回绕、不自动归零
                st["cursor"] = min(idx + 1, total - 1)
                # 下一次运行将取的行号；末条锁住时钳在 total
                next_index = min(idx + 2, total)

        var = {
            "name": str(变量名称),
            "value": value,
            "index": idx + 1 if total else 0,
            "total": total,
            "node_id": key,
            "mode": str(模式),
        }
        # 只截「当前值」这根输出线；var["value"] 保持完整，59 号模板替换不受影响
        short = _short_value(value, 当前值字数)
        return {"ui": {"text": [progress], "next": [next_index]},
                "result": (var, short)}


class ZWNLOVE_VariableRef:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "变量": (VAR_TYPE, {}),
                "模板": ("STRING", {
                    "default": "一只{动物}，高清写实摄影，细节丰富",
                    "multiline": True,
                }),
            },
            # 12 个槽在 Python 侧静态兜底；前端 JS 按已连数量动态显示/隐藏
            "optional": {("变量%d" % i): (VAR_TYPE, {}) for i in range(2, MAX_VARS + 1)},
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "ZWNLOVE/变量"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return _next_tick()

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def run(self, 变量, 模板, **kwargs):
        text = str(模板 or "")
        vars_list = [变量] + [kwargs.get("变量%d" % i) for i in range(2, MAX_VARS + 1)]
        for v in vars_list:
            if isinstance(v, dict) and v.get("name"):
                text = text.replace("{" + str(v["name"]) + "}", str(v.get("value", "")))
        return {"ui": {"text": [text]}, "result": (text,)}


if _HAS_SERVER:
    @PromptServer.instance.routes.post("/zwnlove/reset")
    async def _zwnlove_reset(request):
        """前端「重置游标」按钮：把该节点的游标清回未开始状态。"""
        try:
            data = await request.json()
        except Exception:
            data = {}
        key = str(data.get("node_id", ""))
        try:
            with _LOCK:
                st = _STATE.get(key)
                if st is not None:
                    st["cursor"] = None
            return web.json_response({"ok": True})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)


class ZWNLOVE_CropRatio:
    """裁剪比例选择器：只给比例，不产出任何宽度/高度/分辨率数值。

    这是纯配置节点，不需要接进图像数据流。可视化裁剪面板会按节点类型在画布里
    找到它，读「比例」下拉决定裁剪框是否锁比例：
      自定义宽高  -> 宽高各走各的，随便拖；面板还会出现宽/高输入框可手填像素
      固定比例    -> 拖新框/四边/四角一律等比，只能改大小和位置
      原始比例    -> 直通：红框消失、不裁剪，上游多大就原样输出多大（默认值）
    出图宽高 = 框拖出来的像素 × 缩放比例（缩放默认 1，即等于框像素）；
    裁剪和缩放都在同一个 ZWNLOVE_ImageCrop 节点内完成，不需要再串别的节点。
    """

    RATIOS = [
        "自定义宽高", "1:1", "2:3", "3:2", "3:4", "4:3", "5:7",
        "9:16", "16:9", "21:9", "1:2", "2:1", "原始比例",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"比例": (cls.RATIOS, {"default": "原始比例"})}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("比例",)
    FUNCTION = "run"
    CATEGORY = "ZWNLOVE/裁剪"

    def run(self, 比例):
        return {"ui": {"ratio": [str(比例)]}, "result": (str(比例),)}


class ZWNLOVE_ImageCrop:
    """整合型图片剪裁：一个节点里做完「按比例裁剪 -> 缩放」。

    它就是内置 ImageCrop 的替代执行体（见文件末尾的注册替换），因此所有既有
    工作流里写死的 "type": "ImageCrop" 一个字都不用改，就地获得缩放能力，
    也不需要在后面再串一个 ImageScaleBy。

    2 号现在是「加载 + 剪裁」一体化源头节点：自带原生「图片」上传控件
    （image_upload COMBO），没接上游 IMAGE 线时自己读文件；接了线仍用上游图，
    别人工作流照样能把它接在任意图像节点后面。
    「缩放比例」FLOAT、「比例选择」COMBO、「模式」COMBO 全部是平台原生控件，
    和 width/height/x/y 共用同一套组件、主题配色与下拉图标；DOM 面板只负责
    预览和拖框，不再自绘任何参数控件。

    控件顺序按「参数在前、上传在后」排：width/height/x/y -> 缩放比例 ->
    比例选择 -> 模式 -> 图片 -> 平台自动追加的「选择要上传的文件」按钮。
    这样文件名和上传按钮紧挨着，下面直接接裁剪画布，不再隔着别的参数。

    「比例选择」只是前端拖框的约束依据，后端 run() 不消费它，因此外部 API
    递交的老模板即使不带这个键也照常能跑。
    「图片」必须在 required 里（平台上传扩展的硬要求），「模式」后端不消费，
    只负责渲染成平台原生下拉。

    执行顺序固定：先按 width/height/x/y 裁出框内像素，再整体乘「缩放比例」。
      缩放比例 = 1    -> 原样输出（默认「原始比例」直通，不做任何处理）
      缩放比例 = 0.5  -> 宽高各减半，例如裁出 800x800 后输出 400x400
    放大算法固定 lanczos，不额外暴露控件，保持面板简单。
    """

    # 断点开关（原生 COMBO，默认「正常模式」）：
    #   正常模式 -> 纯剪裁直通，什么都不干预，1/2 号可以完全不摆
    #   断点模式 -> 前端把剪裁图送进 3 号文件下拉、显示出来，然后不递交运行，
    #               等用户在 3 号上画完遮罩再自己点运行
    # 后端 run() 不消费这个值；它只负责被 ComfyUI 渲染成平台原生下拉。
    MODES = ("正常模式", "断点模式")

    @classmethod
    def INPUT_TYPES(cls):
        # 自带原生上传控件：和 ComfyUI 内置 LoadImage 用的是同一套声明，
        # 平台会自动渲染「文件下拉 + 上传按钮 + 缩略图」，不是自绘 UI。
        # 每次调用都重新扫描 input 目录，所以刚上传的新文件能通过
        # validate_inputs 的 COMBO 校验（内置 LoadImage 也是这么做的）。
        import os
        import folder_paths
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir)
                 if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["image"])
        return {
            "required": {
                "width": ("INT", {"default": 512, "min": 1, "max": 16384, "step": 1}),
                "height": ("INT", {"default": 512, "min": 1, "max": 16384, "step": 1}),
                "x": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                "y": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 1}),
                # 先放裁剪参数，再放上传相关控件，参数区末尾固定是
                # 「图片」+ 平台追加的上传按钮这一对。
                "缩放比例": ("FLOAT", {"default": 1.0, "min": 0.2, "max": 1.0, "step": 0.1}),
                "比例选择": (ZWNLOVE_CropRatio.RATIOS, {"default": "原始比例"}),
                "模式": (cls.MODES, {"default": "正常模式"}),
                # 必须放 required 且排在最后：ComfyUI 前端的上传扩展
                # 只扫描 input.required 里带 image_upload 的 COMBO 来生成
                # 「选择文件上传」按钮，放 optional 不会有任何上传控件；
                # 按钮由平台追加到所有参数之后，正好紧跟这一行。
                "图片": (sorted(files), {"image_upload": True}),
            },
            "optional": {
                # IMAGE 端子保留但改成可选：接了上游就用上游的图，
                # 没接就用本节点「图片」控件里选/上传的图，1 号可以完全不摆。
                "image": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "run"
    CATEGORY = "ZWNLOVE/裁剪"

    def run(self, image=None, width=512, height=512, x=0, y=0, **kwargs):
        # 没接上游 IMAGE 线时，用本节点原生「图片」控件选中的文件自己加载。
        # 走内置 LoadImage 的同一套解析（EXIF / alpha / 多帧都一致）。
        if image is None:
            name = kwargs.get("图片", "")
            if not name or str(name).strip() in ("", "无"):
                raise RuntimeError("请先在节点上用「图片」控件选择或上传一张图片")
            from nodes import LoadImage as _LoadImage
            image = _LoadImage().load_image(name)[0]

        # 与内置 ImageCrop 相同的越界处理：起点不许出界，右/下越界靠切片自然截断
        x = min(int(x), image.shape[2] - 1)
        y = min(int(y), image.shape[1] - 1)
        out = image[:, y:y + int(height), x:x + int(width), :]

        # 老工作流的 widgets_values 第 5 项是 DOM widget 的空串，可能被前端塞进来；
        # 这里一律兜回 1.0，避免 float("") 报错
        scale_by = kwargs.get("缩放比例", 1.0)
        try:
            s = float(scale_by)
        except (TypeError, ValueError):
            s = 1.0
        if not (s > 0):
            s = 1.0

        if abs(s - 1.0) > 1e-6:
            import comfy.utils
            samples = out.movedim(-1, 1)
            w = max(1, round(samples.shape[3] * s))
            h = max(1, round(samples.shape[2] * s))
            out = comfy.utils.common_upscale(samples, w, h, "lanczos", "disabled").movedim(1, -1)
        return (out,)


# 断点开关已整合进 ZWNLOVE_ImageCrop（2 号），不再有独立的送图开关节点。


NODE_CLASS_MAPPINGS = {
    "ZWNLOVE_VariablePool": ZWNLOVE_VariablePool,
    "ZWNLOVE_VariableRef": ZWNLOVE_VariableRef,
    "ZWNLOVE_CropRatio": ZWNLOVE_CropRatio,
    # 独立名字：以后往别的工作流里只拖这一个节点就能用全部功能
    "ZWNLOVE_ImageCrop": ZWNLOVE_ImageCrop,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ZWNLOVE_VariablePool": "ZWNLOVE 变量池",
    "ZWNLOVE_VariableRef": "ZWNLOVE 变量引用",
    "ZWNLOVE_CropRatio": "ZWNLOVE 裁剪比例",
    "ZWNLOVE_ImageCrop": "ZWNLOVE 图片剪裁（整合）",
}

# 让所有既有工作流里的内置 ImageCrop 就地升级。
# ComfyUI 加载 custom_nodes 时会用 ignore=base_node_names 拦住同名注册，
# 但插件可以直接替换已注册的类对象；不改 ComfyUI 的任何源文件，升级 ComfyUI
# 也不会被覆盖。效果：工作流 JSON 里 "type": "ImageCrop" 不用动，
# 前端 zwnlove.js 的面板也仍按 ImageCrop 名字挂载，全部自动同步。
try:
    import nodes as _comfy_nodes
    _comfy_nodes.NODE_CLASS_MAPPINGS["ImageCrop"] = ZWNLOVE_ImageCrop
    _comfy_nodes.NODE_DISPLAY_NAME_MAPPINGS["ImageCrop"] = "图片剪裁（ZWNLOVE 整合）"
except Exception as _e:
    print("[ZWNLOVE] ImageCrop 映射替换失败:", _e)

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

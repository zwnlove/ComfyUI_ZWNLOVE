import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const POOL_TYPE = "ZWNLOVE_VariablePool";
const REF_TYPE = "ZWNLOVE_VariableRef";
const VAR_TYPE = "ZWNLOVE_VAR";
const MAX_VARS = 12;

function countItems(value, mode) {
  const s = String(value ?? "");
  if (mode === "提示词模式") {
    const found = s.match(/\[[\s\S]*?\]/g) || [];
    return found.filter((block) => block.slice(1, -1).trim().length > 0).length;
  }
  return s.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length > 0).length;
}

/* ---------------------------------------------------------------- 变量池 */
app.registerExtension({
  name: "ZWNLOVE.VariablePool",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== POOL_TYPE) return;
    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = origCreated ? origCreated.apply(this, arguments) : undefined;
      try {
        setupPool(this);
      } catch (err) {
        console.warn("[ZWNLOVE] pool init failed:", err);
      }
      return result;
    };
  },
});

function setupPool(node) {
  const find = (n) => (node.widgets || []).find((w) => w.name === n);
  const listWidget = find("词条列表");
  const modeWidget = find("模式");
  const pickWidget = find("取值方式");
  const startWidget = find("开始序号");

  // 词条输入框给足高度（之前被整块 DOM 面板挤掉了）
  if (listWidget && listWidget.element) {
    listWidget.element.style.minHeight = "240px";
  }

  // 「开始序号」是实时序号框：显示「下一次运行将取第几条」。
  // 直接赋 value，不触发 callback / DOM 事件，避免被当成手工改动连锁 refresh。
  const setStart = (n) => {
    if (!startWidget) return;
    const v = Math.max(1, Math.min(999999, Number(n) || 1));
    if (Number(startWidget.value) === v) return;
    startWidget.value = v;
    if (startWidget.element && typeof startWidget.element.value !== "undefined") {
      startWidget.element.value = String(v);
    }
    if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
  };

  let cur = 0;
  let total = 0;
  let isRandom = false;

  // 用 button widget 显示进度：只占一行，和「重置游标」同宽同高，不吃节点剩余空间
  let progressWidget = null;
  try {
    progressWidget = node.addWidget("button", "当前进度  0/0", null, () => {}, {
      serialize: false,
    });
  } catch (err) {
    console.warn("[ZWNLOVE] progress widget failed:", err);
  }

  const render = () => {
    let label;
    if (total === 0) {
      label = "当前进度  0/0    （在「词条列表」里填内容）";
    } else if (isRandom) {
      label = "当前进度  随机 " + cur + "/" + total;
    } else {
      const mode = modeWidget ? modeWidget.value : "词条模式";
      const unit = mode === "提示词模式" ? " 段" : " 行";
      label = "当前进度  " + cur + "/" + total + "    剩余 "
        + Math.max(0, total - cur) + unit;
    }
    if (progressWidget) {
      progressWidget.name = label;
      progressWidget.label = label;
    }
    if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
  };

  const refresh = () => {
    const mode = modeWidget ? modeWidget.value : "词条模式";
    total = countItems(listWidget ? listWidget.value : "", mode);
    cur = 0;
    isRandom = pickWidget && pickWidget.value === "随机";
    // 内容 / 模式 / 取值方式变了，或点「重置游标」，或加载工作流：都回到第 1 条
    setStart(1);
    render();
  };

  const el = listWidget && listWidget.element;
  if (el) {
    el.addEventListener("input", refresh);
    el.addEventListener("change", refresh);
  }
  for (const w of [modeWidget, pickWidget]) {
    if (!w) continue;
    const orig = w.callback;
    w.callback = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;
      refresh();
      return r;
    };
  }

  const origConfigure = node.onConfigure;
  node.onConfigure = function () {
    const result = origConfigure ? origConfigure.apply(this, arguments) : undefined;
    setTimeout(refresh, 0);
    return result;
  };

  // 重置游标
  try {
    node.addWidget("button", "重置游标", null, async () => {
      try {
        await api.fetchApi("/zwnlove/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_id: String(node.id) }),
        });
      } catch (err) {
        console.warn("[ZWNLOVE] reset failed:", err);
      }
      refresh();
    }, { serialize: false });
  } catch (err) {
    console.warn("[ZWNLOVE] reset button failed:", err);
  }

  // 每次执行完，用后端返回的真实进度覆盖前端显示
  const onExecuted = (event) => {
    const d = (event && event.detail) || {};
    const nid = d.node ?? d.node_id ?? d.nodeId;
    if (String(nid) !== String(node.id)) return;
    const t = d.output && Array.isArray(d.output.text) ? d.output.text[0] : null;
    const m = /(\d+)\s*\/\s*(\d+)/.exec(String(t || ""));
    if (m) {
      cur = Number(m[1]);
      total = Number(m[2]);
      isRandom = /^随机/.test(String(t));
      render();
      // 顺序模式：把「开始序号」刷成下一次将取的行号，跑完第 6 条就显示 7
      if (!isRandom) {
        const out = d.output || {};
        let nx = Array.isArray(out.next) && out.next.length ? Number(out.next[0]) : 0;
        if (!nx || !isFinite(nx)) nx = total > 0 ? Math.min(cur + 1, total) : 1;
        setStart(nx);
      }
    }
  };
  api.addEventListener("executed", onExecuted);
  // 这是挂在全局 api 上的监听，节点删掉后不会自动失效，必须手动摘，
  // 否则闭包一直攥着 node，切工作流/删节点都会累积
  const origRemoved = node.onRemoved;
  node.onRemoved = function () {
    try { api.removeEventListener("executed", onExecuted); } catch (err) {}
    return origRemoved ? origRemoved.apply(this, arguments) : undefined;
  };

  setTimeout(refresh, 0);
}

/* ------------------------------------------------------------ 变量引用动态槽 */
app.registerExtension({
  name: "ZWNLOVE.VariableRef",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== REF_TYPE) return;
    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = origCreated ? origCreated.apply(this, arguments) : undefined;
      try {
        setupRef(this);
      } catch (err) {
        console.warn("[ZWNLOVE] ref init failed:", err);
      }
      return result;
    };
  },
});

function setupRef(node) {
  const isVarSlot = (i) => !!i && /^变量(\d+)?$/.test(i.name);

  // 只保留「已连线的槽 + 1 个空槽」，最多 12 个
  const syncSlots = () => {
    let slots = node.inputs.filter(isVarSlot);
    let lastConnected = -1;
    slots.forEach((s, i) => {
      if (s.link !== null && s.link !== undefined) lastConnected = i;
    });
    const want = Math.min(MAX_VARS, Math.max(1, lastConnected + 2));

    while (slots.length > want) {
      const s = slots[slots.length - 1];
      if (s.link !== null && s.link !== undefined) break;
      const idx = node.inputs.indexOf(s);
      if (idx < 0) break;
      node.removeInput(idx);
      slots = node.inputs.filter(isVarSlot);
    }
    while (slots.length < want) {
      const n = slots.length + 1;
      node.addInput(n === 1 ? "变量" : "变量" + n, VAR_TYPE);
      slots = node.inputs.filter(isVarSlot);
    }
    if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
  };

  const wrap = (key) => {
    const orig = node[key];
    node[key] = function () {
      const result = orig ? orig.apply(this, arguments) : undefined;
      setTimeout(syncSlots, 0);
      return result;
    };
  };
  wrap("onConnectionsChange");
  wrap("onConfigure");

  setTimeout(syncSlots, 0);
}

/* ============================== 自由裁剪框：给内置 ImageCrop 挂可视化拖拽面板 */
// CROP_TESTABLE_BEGIN
const RATIO_TYPE = "ZWNLOVE_CropRatio";
const PASS_RATIO = "原始比例"; // 直通：不裁剪、不显示红框，上游多大就原样输出多大
const FREE_RATIO = "自定义宽高"; // 自由拖框决定像素，比例不锁；也可在面板里手填宽高
const CROP_RATIOS = [
  FREE_RATIO, "1:1", "2:3", "3:2", "3:4", "4:3", "5:7",
  "9:16", "16:9", "21:9", "1:2", "2:1", PASS_RATIO,
];

function cgClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function cgRect(x, y, w, h) { return { x: +x, y: +y, w: +w, h: +h }; }

/** 自由拉框：任意方向拖拽，归一化成正宽高，不做任何比例锁定 */
function cgFromDrag(x0, y0, x1, y1, bounds, minSize) {
  minSize = minSize || 8;
  const b = bounds || { w: 1e9, h: 1e9 };
  const ax = cgClamp(Math.min(x0, x1), 0, b.w);
  const bx = cgClamp(Math.max(x0, x1), 0, b.w);
  const ay = cgClamp(Math.min(y0, y1), 0, b.h);
  const by = cgClamp(Math.max(y0, y1), 0, b.h);
  return cgRect(ax, ay, Math.max(minSize, bx - ax), Math.max(minSize, by - ay));
}

/** 命中判定：8 手柄 > 框内移动 > 空白处新建 */
function cgHit(px, py, r, tol) {
  const L = r.x, R = r.x + r.w, T = r.y, B = r.y + r.h;
  // 容差随框变小而收窄；且必须落在对应轴的范围内才算命中边，
  // 否则「框左右两侧的空白处」会被误判成拉上下边，拖不出新框。
  const t = Math.min(tol || 10, Math.max(3, Math.min(r.w, r.h) * 0.25));
  const nearX = px >= L - t && px <= R + t;
  const nearY = py >= T - t && py <= B + t;
  const hx = nearY ? (Math.abs(px - L) <= t ? "w" : Math.abs(px - R) <= t ? "e" : "") : "";
  const hy = nearX ? (Math.abs(py - T) <= t ? "n" : Math.abs(py - B) <= t ? "s" : "") : "";
  if (hx && hy) return { mode: "resize", handle: hy + hx };
  if (hx) return { mode: "resize", handle: hx };
  if (hy) return { mode: "resize", handle: hy };
  if (px > L && px < R && py > T && py < B) return { mode: "move", handle: null };
  return { mode: "new", handle: null };
}

/** 拉伸：只动命中的边，长宽各自独立，绝不锁比例 */
function cgResize(r, handle, dx, dy, bounds, minSize) {
  minSize = minSize || 8;
  const b = bounds || { w: 1e9, h: 1e9 };
  let L = r.x, T = r.y, R = r.x + r.w, B = r.y + r.h;
  if (handle.indexOf("w") >= 0) L = cgClamp(L + dx, 0, b.w);
  if (handle.indexOf("e") >= 0) R = cgClamp(R + dx, 0, b.w);
  if (handle.indexOf("n") >= 0) T = cgClamp(T + dy, 0, b.h);
  if (handle.indexOf("s") >= 0) B = cgClamp(B + dy, 0, b.h);
  let nx = Math.min(L, R), nr = Math.max(L, R);
  let ny = Math.min(T, B), nb = Math.max(T, B);
  if (nr - nx < minSize) {
    if (handle.indexOf("w") >= 0) nx = Math.max(0, nr - minSize);
    else nr = Math.min(b.w, nx + minSize);
  }
  if (nb - ny < minSize) {
    if (handle.indexOf("n") >= 0) ny = Math.max(0, nb - minSize);
    else nb = Math.min(b.h, ny + minSize);
  }
  return cgRect(nx, ny, nr - nx, nb - ny);
}

function cgMove(r, dx, dy, bounds) {
  const b = bounds || { w: 1e9, h: 1e9 };
  return cgRect(
    cgClamp(r.x + dx, 0, Math.max(0, b.w - r.w)),
    cgClamp(r.y + dy, 0, Math.max(0, b.h - r.h)),
    r.w, r.h
  );
}

/** 显示像素 -> 原图像素，严格夹在原图范围内 */
function cgToSource(r, scale, imgW, imgH) {
  if (!(scale > 0)) return { x: 0, y: 0, w: imgW, h: imgH };
  let x = Math.round(r.x / scale), y = Math.round(r.y / scale);
  let w = Math.round(r.w / scale), h = Math.round(r.h / scale);
  x = cgClamp(x, 0, imgW - 1);
  y = cgClamp(y, 0, imgH - 1);
  w = cgClamp(w, 1, imgW - x);
  h = cgClamp(h, 1, imgH - y);
  return { x: x, y: y, w: w, h: h };
}

function cgFromSource(s, scale) {
  return cgRect(s.x * scale, s.y * scale, s.w * scale, s.h * scale);
}

/** 比例名 -> 宽/高数值；「自定义宽高」（含旧名「自定义」）与「原始比例」都是自由/直通，返回 null */
function cgRatioValue(name, imgW, imgH) {
  if (!name || name === FREE_RATIO || name === "自定义" || name === PASS_RATIO) return null;
  const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(String(name));
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return (a > 0 && b > 0) ? a / b : null;
}

/** 把任意矩形改成指定比例（保持中心与面积），并夹在画布内 */
function cgConform(r, ratio, bounds) {
  if (!ratio || !(ratio > 0)) return r;
  const b = bounds || { w: 1e9, h: 1e9 };
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const area = Math.max(64, r.w * r.h);
  let w = Math.sqrt(area * ratio), h = w / ratio;
  const f = Math.min(1, b.w / w, b.h / h);
  w *= f; h *= f;
  return cgRect(
    cgClamp(cx - w / 2, 0, Math.max(0, b.w - w)),
    cgClamp(cy - h / 2, 0, Math.max(0, b.h - h)),
    w, h
  );
}

/** 拖新框（锁比例版）：按拖拽范围取较大等效尺寸，锚点是按下点 */
function cgFromDragRatio(x0, y0, x1, y1, bounds, ratio, minSize) {
  if (!ratio || !(ratio > 0)) return cgFromDrag(x0, y0, x1, y1, bounds, minSize);
  minSize = minSize || 8;
  const b = bounds || { w: 1e9, h: 1e9 };
  const sx = x1 < x0 ? -1 : 1, sy = y1 < y0 ? -1 : 1;
  const dw = Math.abs(x1 - x0), dh = Math.abs(y1 - y0);
  let w = Math.max(dw, dh * ratio, minSize), h = w / ratio;
  const maxW = cgClamp(sx > 0 ? b.w - x0 : x0, 0, b.w);
  const maxH = cgClamp(sy > 0 ? b.h - y0 : y0, 0, b.h);
  const f = Math.min(1, maxW / w, maxH / h);
  w = Math.max(minSize, w * f); h = w / ratio;
  if (h < minSize) { h = minSize; w = h * ratio; }
  if (h > maxH) { h = maxH; w = h * ratio; }
  if (w > maxW) { w = maxW; h = w / ratio; }
  const x = sx > 0 ? x0 : x0 - w;
  const y = sy > 0 ? y0 : y0 - h;
  return cgRect(cgClamp(x, 0, Math.max(0, b.w - w)),
               cgClamp(y, 0, Math.max(0, b.h - h)), w, h);
}

/** 拉伸（锁比例版）：未被拖动的边当锚点，另一轴按 ratio 推导 */
function cgResizeRatio(r, handle, dx, dy, bounds, ratio, minSize) {
  if (!ratio || !(ratio > 0)) return cgResize(r, handle, dx, dy, bounds, minSize);
  minSize = minSize || 8;
  const b = bounds || { w: 1e9, h: 1e9 };
  const free = cgResize(r, handle, dx, dy, b, minSize);
  const hasW = handle.indexOf("w") >= 0, hasE = handle.indexOf("e") >= 0;
  const hasN = handle.indexOf("n") >= 0, hasS = handle.indexOf("s") >= 0;
  const horizontal = hasW || hasE, vertical = hasN || hasS;
  let w;
  if (horizontal && vertical) {
    w = Math.abs(free.w - r.w) >= Math.abs(free.h - r.h) * ratio ? free.w : free.h * ratio;
  } else if (horizontal) w = free.w;
  else w = free.h * ratio;
  let h = w / ratio;
  const R0 = r.x + r.w, B0 = r.y + r.h;
  const maxW = hasW ? R0 : (b.w - r.x);
  const maxH = hasN ? B0 : (b.h - r.y);
  if (w > maxW) { w = maxW; h = w / ratio; }
  if (h > maxH) { h = maxH; w = h * ratio; }
  w = Math.max(minSize, w); h = w / ratio;
  if (h < minSize) { h = minSize; w = h * ratio; }
  const x = hasW ? R0 - w : r.x;
  const y = hasN ? B0 - h : r.y;
  return cgRect(cgClamp(x, 0, Math.max(0, b.w - w)),
               cgClamp(y, 0, Math.max(0, b.h - h)), w, h);
}

/** 整数像素下严格保持比例：以宽为准推高，再夹回原图范围内 */
function cgSourceRatio(s, ratio, imgW, imgH) {
  if (!ratio || !(ratio > 0)) return s;
  let w = cgClamp(Math.max(1, s.w), 1, Math.max(1, imgW - s.x));
  let h = Math.max(1, Math.round(w / ratio));
  const maxH = Math.max(1, imgH - s.y);
  if (h > maxH) { h = maxH; w = Math.max(1, Math.round(h * ratio)); }
  return { x: s.x, y: s.y, w: cgClamp(w, 1, imgW - s.x), h: h };
}

app.registerExtension({
  name: "ZWNLOVE.ImageCropVisual",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    // ImageCrop 已被我们的整合节点就地替换（见 __init__.py 末尾的注册替换），
    // ZWNLOVE_ImageCrop 是同一份类的独立名字，两种都要挂面板。
    if (!nodeData || (nodeData.name !== "ImageCrop" && nodeData.name !== "ZWNLOVE_ImageCrop")) return;
    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;
      try { this.__zwnCropVisual = setupCropVisual(this); }
      catch (err) { console.warn("[ZWNLOVE] crop visual:", err); }
      return r;
    };
  },
});

// 源图控件：2 号自带的原生上传控件叫「图片」，上游 LoadImage 的叫「image」。
// 只按名字认，绝不退回「第一个 combo」，否则会误绑到「比例选择」。
function zwnImageWidget(n) {
  if (!n) return null;
  return (n.widgets || []).find(
    (w) => w && (w.name === "图片" || w.name === "image")) || null;
}

// 送图 / 预览共用的源图：接了上游 IMAGE 线读上游，没线就读 2 号自己。
function zwnCropImageWidget(node) {
  const up = zwnUpstream(node, 0);
  return zwnImageWidget(up) || zwnImageWidget(node);
}

function setupCropVisual(node) {
  // 平台 image_upload 控件在选中文件后会异步把同一张图塞进 node.imgs，
  // LiteGraph 再把它画在节点底部（还带 W×H 尺寸文字），于是和下面的裁剪
  // 画布出现两张一模一样的图。这里只吞掉本节点的 imgs 赋值：文件下拉、
  // 上传按钮、别的节点、运行出图预览都不受影响，图片统一由裁剪画布显示。
  try {
    Object.defineProperty(node, "imgs", {
      configurable: true,
      get() { return undefined; },
      set() { /* 重复的那层平台预览，丢弃 */ },
    });
  } catch (err) {
    console.warn("[ZWNLOVE] 屏蔽重复预览失败:", err);
  }
  // width/height 接了外部 INT 线时，新版前端会把 widget 名字写成 UNKNOWN，
  // 但 widget 对象仍在 node.widgets 里，顺序固定为 width, height, x, y。
  // 断线 / 连线两种状态都要能定位，否则面板直接不挂载。
  const ws = node.widgets || [];
  const findW = (n, i) => ws.find((w) => w && w.name === n) || ws[i] || null;
  const wW = findW("width", 0), wH = findW("height", 1);
  const wX = findW("x", 2), wY = findW("y", 3);
  if (!wW || !wH || !wX || !wY) return null;
  // 「缩放比例」是本节点自己的后端输入，不再往下游找 ImageScaleBy。
  // 后端键名已统一成中文，同时兼容旧的英文键名，避免改名过渡期写回失效。
  const scaleWidget = () => (node.widgets || []).find(
    (w) => w && (w.name === "缩放比例" || w.name === "scale_by")) || null;
  // 「比例选择」是后端声明的原生 COMBO widget，和 width/height/x/y 同一套 UI 组件
  const ratioWidget = () => (node.widgets || []).find(
    (w) => w && w.name === "比例选择") || null;

  const mk = (tag, cls, css) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (css) e.style.cssText = css;
    return e;
  };

  // 面板不再自绘任何参数控件：比例选择 / 缩放比例 / 宽高 / X / Y 全部使用节点
  // 自己的原生 widget，配色、字体、下拉图标由 ComfyUI 统一渲染，天然一致。
  // 这里只保留「预览图 + 可拖拽红框」这块画布。
  // 清掉旧版注入过的自绘胶囊样式，避免刷新前残留。
  const legacyStyle = document.getElementById("zwn-crop-style");
  if (legacyStyle) legacyStyle.remove();
  const root = mk("div", "zwn-crop-root",
    "position:relative;width:100%;height:100%;min-height:0;box-sizing:border-box;display:flex;flex-direction:column;padding:4px;color:inherit;font:12px/1.4 sans-serif;");

  const stage = mk("div", "zwn-crop-stage",
    "position:relative;flex:1 1 auto;min-height:300px;display:flex;align-items:center;justify-content:center;width:100%;overflow:hidden;background:rgba(127,127,127,.10);");
  const inner = mk("div", "zwn-crop-inner",
    "position:relative;flex:0 0 auto;touch-action:none;cursor:crosshair;user-select:none;");
  const imgEl = mk("img", "zwn-crop-img",
    "display:block;width:100%;height:100%;pointer-events:none;user-select:none;-webkit-user-drag:none;");
  const box = mk("div", "zwn-crop-box",
    "position:absolute;pointer-events:none;border:2px solid #ff453a;box-shadow:0 0 0 1px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.45);background:rgba(255,69,58,.12);box-sizing:border-box;");
  box.style.display = "none"; // 默认「原始比例」直通，红框从一开始就不显示
  const hpos = {
    nw: "left:-5px;top:-5px;", n: "left:50%;top:-5px;transform:translateX(-50%);",
    ne: "right:-5px;top:-5px;", e: "right:-5px;top:50%;transform:translateY(-50%);",
    se: "right:-5px;bottom:-5px;", s: "left:50%;bottom:-5px;transform:translateX(-50%);",
    sw: "left:-5px;bottom:-5px;", w: "left:-5px;top:50%;transform:translateY(-50%);",
  };
  for (const k of Object.keys(hpos)) {
    box.appendChild(mk("div", "zwn-crop-h zwn-crop-h-" + k,
      "position:absolute;width:10px;height:10px;background:#fff;border:1px solid #ff453a;border-radius:2px;pointer-events:none;box-sizing:border-box;" + hpos[k]));
  }
  inner.appendChild(imgEl); inner.appendChild(box); stage.appendChild(inner);
  root.appendChild(stage);

  // 高度机制：DOM widget 的 minHeight 会参与 ComfyUI 的节点尺寸计算。
  // 之前让 getMinHeight 返回 node.size[1]-134，前端再按 widget 高度回撑 node.size，
  // 两边互相喂 -> 正反馈 -> 节点无限长高、图片被拉到几万像素。
  // 现在只给固定下限、不设上限：用户把节点拉高时，多出来的空间由前端自动分给
  // 这个 widget，预览区用 flex:1 撑满，全程不读 node.size，彻底断掉循环。
  const WIDGET_MIN_HEIGHT = 340;
  let domWidget = null;
  try {
    domWidget = node.addDOMWidget("可视化裁剪", "zwnlove-crop", root, {
      serialize: false, hideOnZoom: false,
      getMinHeight: () => WIDGET_MIN_HEIGHT,
    });
  } catch (err) {
    console.warn("[ZWNLOVE] addDOMWidget:", err);
  }
  // 兜底：以前被撑到超大尺寸的工作流，打开时一次性钳回正常高度
  let heightClamped = false;
  setTimeout(() => {
    if (heightClamped) return;
    heightClamped = true;
    const s = node.size;
    if (s && s[1] > 1600) {
      try { node.setSize([s[0], 620]); } catch (err) {}
    }
  }, 300);
  // 原生 widget 一个都不隐藏：width / height / x / y / 缩放比例 / 比例选择
  // 全部显示在节点参数区，由 ComfyUI 统一渲染。

  let imgW = 0, imgH = 0, scale = 1;
  let rect = cgRect(0, 0, 0, 0);
  let drag = null, rafId = 0;
  let currentRatioName = PASS_RATIO;
  let currentRatio = null;
  const isPass = () => currentRatioName === PASS_RATIO;

  // 比例来自本节点的原生「比例选择」COMBO；画布上若还留着独立的
  // ZWNLOVE 裁剪比例节点，仅作兼容读取，不再作为主入口。
  const ratioNodes = () => (app.graph && app.graph._nodes) ? app.graph._nodes : [];
  const ratioNode = () => ratioNodes().find((n) => n && n.type === RATIO_TYPE) || null;
  const ratioNodeWidget = (n) => {
    const list = n && n.widgets ? n.widgets : [];
    return list.find((w) => w && w.name === "比例") || list[0] || null;
  };
  const applyRatioName = (name, syncWidget) => {
    const prevPass = isPass();
    // 旧独立节点里可能还存着「自定义」，统一映射成新名「自定义宽高」
    const real = name === "自定义" ? FREE_RATIO : name;
    const v = CROP_RATIOS.indexOf(real) >= 0 ? real : PASS_RATIO;
    currentRatioName = v;
    if (syncWidget) {
      const w = ratioWidget();
      if (w) {
        w.value = v;
        if (w.element && "value" in w.element) w.element.value = v;
        if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
      }
    }
    currentRatio = cgRatioValue(v, imgW, imgH);
    // 「原始比例」＝直通：红框消失、拖框禁用、写回整图尺寸，上游多大输出多大。
    box.style.display = isPass() ? "none" : "";
    if (imgW) {
      if (isPass()) {
        rect = cgFromSource({ x: 0, y: 0, w: imgW, h: imgH }, scale);
      } else {
        if (prevPass || rect.w <= 1 || rect.h <= 1) {
          rect = cgFromSource({
            x: Math.round(imgW * 0.1), y: Math.round(imgH * 0.1),
            w: Math.round(imgW * 0.8), h: Math.round(imgH * 0.8),
          }, scale);
        }
        rect = cgConform(rect, currentRatio, bounds());
      }
      paint(); commit();
    }
  };

  /** 比例唯一来源：本节点原生「比例选择」COMBO。
   *  画布上若还留着独立的 ZWNLOVE 裁剪比例节点，也兼容读它，但不再优先。 */
  const syncFromNative = () => {
    const w = ratioWidget();
    const nw = ratioNodeWidget(ratioNode());
    const raw = w ? w.value : (nw ? nw.value : PASS_RATIO);
    const v = String(raw == null ? PASS_RATIO : raw);
    if (v !== currentRatioName) applyRatioName(v, false);
  };
  const bindRatioNode = () => {
    const n = ratioNode();
    if (!n || n.__zwnRatioBound) return;
    n.__zwnRatioBound = true;
    const w = ratioNodeWidget(n);
    if (w) {
      const orig = w.callback;
      w.callback = function () {
        const r = orig ? orig.apply(this, arguments) : undefined;
        syncFromNative();
        return r;
      };
    }
  };
  /** 手改节点原生 width/height/x/y 时把红框同步回来：参数区是唯一真相 */
  const syncRectFromWidgets = () => {
    if (!imgW || !imgH || isPass()) return;
    // 用户清空输入框 / 输入中间态时 value 可能是空串或 0：保持原框不动，
    // 不能把它当成 1 像素把裁剪框压没了。
    const num = (w, d, min) => {
      const v = Number(w && w.value);
      return Number.isFinite(v) && v >= min ? v : d;
    };
    const s = { x: num(wX, 0, 0), y: num(wY, 0, 0),
                w: num(wW, null, 1), h: num(wH, null, 1) };
    if (s.w == null || s.h == null) return;
    s.x = Math.min(s.x, imgW - 1); s.y = Math.min(s.y, imgH - 1);
    s.w = Math.min(s.w, imgW - s.x); s.h = Math.min(s.h, imgH - s.y);
    if (!(s.w > 0 && s.h > 0)) return;
    rect = cgFromSource(s, scale);
    if (currentRatio) rect = cgConform(rect, currentRatio, bounds());
    paint();
  };
  /** 包装原生 widget 的 callback：改比例立刻重算框，改宽高立刻同步框 */
  const bindNativeWidgets = () => {
    const rw = ratioWidget();
    if (rw && !rw.__zwnCropBound) {
      rw.__zwnCropBound = true;
      const orig = rw.callback;
      rw.callback = function () {
        const r = orig ? orig.apply(this, arguments) : undefined;
        syncFromNative();
        return r;
      };
    }
    for (const q of [wW, wH, wX, wY]) {
      if (!q || q.__zwnCropBound) continue;
      q.__zwnCropBound = true;
      const orig = q.callback;
      q.callback = function (v) {
        // 前端派发的回调参数是用户刚输入的值；有些原生 callback 会二次加工
        // widget.value，所以先按这个值同步红框，再把控制权交回原生逻辑。
        if (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v))) {
          q.value = v;
        }
        syncRectFromWidgets();
        return orig ? orig.apply(this, arguments) : undefined;
      };
    }
  };
  /** 缩放比例直接读节点原生 FLOAT widget，面板不再自己存一份值 */
  const getScaleValue = () => {
    const w = scaleWidget();
    const v = w ? Number(w.value) : 1;
    return v > 0 ? v : 1;
  };

  const bounds = () => ({ w: imgW ? imgW * scale : (stage.clientWidth || 400), h: imgH ? imgH * scale : 300 });

  const paint = () => {
    box.style.left = rect.x + "px";
    box.style.top = rect.y + "px";
    box.style.width = rect.w + "px";
    box.style.height = rect.h + "px";
  };
  const schedulePaint = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; paint(); });
  };
  /** 容器从隐藏变可见、节点被拉大时重算预览尺寸，并保住框在原图中的位置。
   *  预览按「等比填满可用区域」跟着节点长，不再写死 380/300/1 这些上限。 */
  const relayout = (convert = true) => {
    if (!imgW || !imgH) return;
    const availW = stage.clientWidth || 400;
    const availH = stage.clientHeight || 300;
    const next = Math.min(availW / imgW, availH / imgH, 16);
    if (!(next > 0) || Math.abs(next - scale) < 1e-6) return;
    const src = convert && scale > 0 ? cgToSource(rect, scale, imgW, imgH) : null;
    scale = next;
    inner.style.width = imgW * scale + "px";
    inner.style.height = imgH * scale + "px";
    if (isPass()) rect = cgFromSource({ x: 0, y: 0, w: imgW, h: imgH }, scale);
    else if (src) rect = cgFromSource(src, scale);
    paint();
  };
  if (typeof ResizeObserver !== "undefined") {
    // 重复挂载时先掐掉上一个，节点删除时由 onRemoved 统一清理
    try { node.__zwnCropRO?.disconnect?.(); } catch (err) {}
    try {
      const ro = new ResizeObserver(() => relayout(true));
      ro.observe(stage);
      node.__zwnCropRO = ro;
    } catch (err) {}
  }
  const commit = () => {
    if (!imgW || !imgH) return;
    let s = isPass() ? { x: 0, y: 0, w: imgW, h: imgH }
                     : cgToSource(rect, scale, imgW, imgH);
    if (currentRatio && !isPass()) {
      // 锁比例时把写回的整数宽高也对齐到该比例，保证所见即所得
      s = cgSourceRatio(s, currentRatio, imgW, imgH);
      rect = cgFromSource(s, scale);
      box.style.left = rect.x + "px"; box.style.top = rect.y + "px";
      box.style.width = rect.w + "px"; box.style.height = rect.h + "px";
    }
    const set = (w, v) => {
      if (!w) return;
      w.value = v;
      if (w.element && "value" in w.element) w.element.value = String(v);
    };
    set(wW, s.w); set(wH, s.h); set(wX, s.x); set(wY, s.y);
    if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
  };
  // 接了上游 IMAGE 线用上游，没接就用本节点「图片」控件里选/上传的图
  const sourceNode = () => zwnUpstream(node, 0) || node;
  const loadImage = () => {
    const src = sourceNode();
    const iw = zwnImageWidget(src);
    if (!iw || !iw.value || String(iw.value).trim() === "无") {
      console.warn("[ZWNLOVE] 还没选图片，请用节点上的「图片」控件添加一张");
      return;
    }
    const raw = String(iw.value).replace(/\\/g, "/");
    const slash = raw.lastIndexOf("/");
    const name = slash >= 0 ? raw.slice(slash + 1) : raw;
    const sub = slash >= 0 ? raw.slice(0, slash) : "";
    const url = api.apiURL("/view?filename=" + encodeURIComponent(name)
      + "&type=input&subfolder=" + encodeURIComponent(sub) + "&t=" + Date.now());
    const probe = new Image();
    probe.onload = () => {
      imgW = probe.naturalWidth; imgH = probe.naturalHeight;
      imgEl.src = url;
      scale = 0; rect = cgRect(0, 0, 0, 0);
      relayout(false);
      const cur = {
        x: Number(wX.value) || 0, y: Number(wY.value) || 0,
        w: Number(wW.value) || 0, h: Number(wH.value) || 0,
      };
      const valid = cur.w > 0 && cur.h > 0 && cur.x + cur.w <= imgW && cur.y + cur.h <= imgH;
      // 不合法时用居中 80% 框：四周留白，用户才能在空白处拖出新框
      const seed = valid ? cur : {
        x: Math.round(imgW * 0.1), y: Math.round(imgH * 0.1),
        w: Math.round(imgW * 0.8), h: Math.round(imgH * 0.8),
      };
      bindRatioNode();
      bindNativeWidgets();
      syncFromNative();
      currentRatio = cgRatioValue(currentRatioName, imgW, imgH);
      box.style.display = isPass() ? "none" : "";
      if (isPass()) {
        rect = cgFromSource({ x: 0, y: 0, w: imgW, h: imgH }, scale);
      } else {
        rect = cgFromSource(seed, scale);
        rect = cgConform(rect, currentRatio, bounds());
      }
      paint(); commit();
    };
    probe.onerror = () => { console.warn("[ZWNLOVE] 图片读取失败，请重新上传图片"); };
    probe.src = url;
  };
  const bindUpstream = () => {
    const iw = zwnImageWidget(sourceNode());
    if (!iw || iw.__zwnCropBound) return;
    iw.__zwnCropBound = true;
    const orig = iw.callback;
    iw.callback = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;
      // 用户主动换图 / 上传：回到原始比例、红框消失、输出整图，
      // 看上去就是一个正常的加载图片节点；之后选比例才开始调整。
      try { applyRatioName(PASS_RATIO, true); } catch (err) {}
      setTimeout(loadImage, 80);
      return r;
    };
  };

  const localPos = (e) => {
    const r = inner.getBoundingClientRect();
    // DOM widget 容器带画布 CSS transform：getBoundingClientRect 是缩放后的屏幕
    // 尺寸，而 rect/scale 用的是未缩放的布局像素。不换算会让鼠标位置与裁剪框
    // 对不上（按下位置被误判成移动/拉伸），必须把屏幕坐标乘回布局坐标。
    const ow = inner.offsetWidth || r.width;
    const oh = inner.offsetHeight || r.height;
    const sx = r.width ? ow / r.width : 1;
    const sy = r.height ? oh / r.height : 1;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  };
  inner.addEventListener("pointerdown", (e) => {
    if (!imgW) { loadImage(); return; }
    if (isPass()) return; // 直通模式不裁剪，红框也不显示
    e.preventDefault(); e.stopPropagation();
    syncFromNative();
    const p = localPos(e);
    const hit = cgHit(p.x, p.y, rect, 10);
    drag = { mode: hit.mode, handle: hit.handle, x0: p.x, y0: p.y,
             ratio: currentRatio,
             start: cgRect(rect.x, rect.y, rect.w, rect.h) };
    if (hit.mode === "new") rect = cgRect(p.x, p.y, 1, 1);
    try { inner.setPointerCapture(e.pointerId); } catch (err) {}
    schedulePaint();
  });
  inner.addEventListener("pointermove", (e) => {
    if (!drag) return;
    e.preventDefault(); e.stopPropagation();
    const p = localPos(e), b = bounds(), ratio = drag.ratio;
    if (drag.mode === "new") rect = cgFromDragRatio(drag.x0, drag.y0, p.x, p.y, b, ratio, 8);
    else if (drag.mode === "move") rect = cgMove(drag.start, p.x - drag.x0, p.y - drag.y0, b);
    else rect = cgResizeRatio(drag.start, drag.handle, p.x - drag.x0, p.y - drag.y0, b, ratio, 8);
    schedulePaint();
  });
  const endDrag = (e) => {
    if (!drag) return;
    if (e) e.stopPropagation();
    drag = null;
    try { inner.releasePointerCapture(e.pointerId); } catch (err) {}
    paint(); commit();
  };
  inner.addEventListener("pointerup", endDrag);
  inner.addEventListener("pointercancel", endDrag);

  const origConn = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    const r = origConn ? origConn.apply(this, arguments) : undefined;
    setTimeout(() => { bindUpstream(); bindRatioNode(); bindNativeWidgets(); loadImage(); }, 120);
    return r;
  };
  const origConf = node.onConfigure;
  node.onConfigure = function () {
    const r = origConf ? origConf.apply(this, arguments) : undefined;
    setTimeout(() => { bindUpstream(); bindRatioNode(); bindNativeWidgets(); syncFromNative(); loadImage(); }, 200);
    return r;
  };
  setTimeout(() => { bindUpstream(); bindRatioNode(); bindNativeWidgets(); syncFromNative(); loadImage(); }, 150);

  return { root: root, stage: stage, inner: inner, box: box, commit: commit,
           loadImage: loadImage, paint: paint,
           ratioWidget: ratioWidget, scaleWidget: scaleWidget,
           bindNativeWidgets: bindNativeWidgets, syncFromNative: syncFromNative,
           syncRectFromWidgets: syncRectFromWidgets,
           setRatio: (name) => applyRatioName(name, true),
           getRatioName: () => currentRatioName,
           getRatio: () => currentRatio,
           getScaleValue: getScaleValue,
           isPass: isPass,
           widgets: { width: wW, height: wH, x: wX, y: wY },
           getRect: () => cgRect(rect.x, rect.y, rect.w, rect.h),
           getScale: () => scale };
}
// CROP_TESTABLE_END

/* ==================================================================
   模式开关（已整合进 2 号 ImageCrop，不再有独立的 13 号节点）
   2 号原生 COMBO「模式」切到「加载模式」时，把源图按 2 号自己的
   width/height/x/y/缩放比例 裁好，存进「加载图像 孤海」自己的
   image 文件下拉，替代「手工上传」这一步。

   只写 3 号原生就有的 image widget，不改 3 号任何代码，
   也不依赖我们给 3 号加的「图像输入」端子 —— 别人原版 3 号照样能用。
   反过来说：加载模式下那根「图像输出 → 图像输入」的线会被本文件在
   提交 prompt 时摘掉（见文件末尾 LoadModeLinkGuard），所以线可以一直
   连着，切回正常模式立刻恢复生效，不用手动加线删线。
   参数区全部由后端声明的原生 widget 渲染，这里一行自绘 UI 都没有。
   ================================================================== */
const ZWN_CROP_TYPES = new Set(["ImageCrop", "ZWNLOVE_ImageCrop"]);
const ZWN_MODE_NORMAL = "正常模式";
const ZWN_MODE_LOAD = "加载模式";
// 旧名字（断点模式）。后端没重启前下拉里还是它，读的时候一并认。
const ZWN_MODE_LEGACY = "断点模式";

// 是不是「加载模式」：新名字、旧名字都算，重启前后都能工作
function zwnIsLoadMode(modeWidget) {
  const v = String((modeWidget && modeWidget.value) ?? "");
  return v === ZWN_MODE_LOAD || v === ZWN_MODE_LEGACY;
}

// 把模式值收敛到「下拉里真实存在的那一个」。
// 旧工作流存的是「断点模式」，后端换成「加载模式」后会被 validate_inputs 拦成
// Value not in list，所以这里翻成当前下拉支持的写法；其它非法值退回正常模式。
function zwnNormalizeModeValue(modeWidget) {
  if (!modeWidget) return;
  const vals = Array.isArray(modeWidget.options?.values) ? modeWidget.options.values : null;
  const loadLabel = vals
    ? (vals.includes(ZWN_MODE_LOAD) ? ZWN_MODE_LOAD
      : (vals.includes(ZWN_MODE_LEGACY) ? ZWN_MODE_LEGACY : null))
    : ZWN_MODE_LOAD;
  if (zwnIsLoadMode(modeWidget)) {
    if (loadLabel && String(modeWidget.value) !== loadLabel) modeWidget.value = loadLabel;
  } else if (String(modeWidget.value ?? "") !== ZWN_MODE_NORMAL) {
    modeWidget.value = ZWN_MODE_NORMAL;
  }
}

/* 加载模式下把「图像输入」这根线在提交时摘掉 ------------------------------
   用户不用删线：线留在画布上（看得见、保存得住），只在组装 prompt 时把
   目标节点的 图像输入 键删掉，后端收到的就是 None → 走文件分支、遮罩正常。
   同时下游不吃这个输出，裁剪节点自然被剪枝，不会多跑一遍。
   切回正常模式，线立刻恢复生效。 */
function zwnStripLoadModeLinks(output) {
  if (!output || typeof output !== "object") return 0;
  const graph = app.graph;
  if (!graph) return 0;
  const loadIds = new Set();
  const collect = (list) => {
    for (const n of list || []) {
      if (!n || !ZWN_CROP_TYPES.has(n.type)) continue;
      const w = (n.widgets || []).find((x) => x && x.name === "模式");
      if (zwnIsLoadMode(w)) loadIds.add(String(n.id));
    }
  };
  collect(graph._nodes);
  // 子图里的节点也要算：LGraph 的 subgraphs 里各有一份 _nodes
  for (const sg of graph.subgraphs?.values?.() ?? []) collect(sg?._nodes);
  if (!loadIds.size) return 0;
  // 子图内节点的执行 id 形如 "1:2:303"（ExecutableNodeDTO），最后一段才是原始 id
  const tail = (id) => {
    const s = String(id ?? "");
    const i = s.lastIndexOf(":");
    return i >= 0 ? s.slice(i + 1) : s;
  };
  let hit = 0;
  for (const entry of Object.values(output)) {
    const ins = entry && entry.inputs;
    if (!ins) continue;
    const v = ins["图像输入"];
    if (!Array.isArray(v)) continue;
    const src = String(v[0]);
    if (loadIds.has(src) || (src.includes(":") && loadIds.has(tail(src)))) {
      delete ins["图像输入"];
      hit++;
    }
  }
  return hit;
}

// 「图片」控件引用的文件可能已不在 input 目录（清理缓存、挪走图片、换机器
// 打开都会造成悬空引用）。平台「缺少媒体输入」扫描会把悬空引用判成缺文件：
// 节点爆红、点运行弹「Image Crop 缺少所需的媒体文件」，哪怕 image 端子已经
// 接了上游、根本用不到这张图。这里把悬空引用收敛成「无」——「无」是后端
// 下拉里的合法选项，平台校验放行不爆红；画布面板对「无」也按未选图处理，
// 只显示空画布不报错。真跑起来缺图时后端会给一句中文提示。
function zwnNormalizePictureWidget(node) {
  const w = (node.widgets || []).find((x) => x && x.name === "图片");
  if (!w || typeof w.value !== "string") return;
  const v = w.value;
  // 值可能带 "文件名 [input]" 这类注解，去掉注解再比对
  const base = v.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  if (!base || base === "无") {
    // 空值会被平台判成「媒体输入未选择文件」爆红，统一收敛成「无」
    if (v !== "无") {
      w.value = "无";
      const vals = w.options && w.options.values;
      if (Array.isArray(vals) && !vals.includes("无")) vals.unshift("无");
    }
    return;
  }
  const vals = Array.isArray(w.options && w.options.values) ? w.options.values : null;
  // 只有拿不到选项列表（options 还没挂上）才不动它；空数组说明 input 目录
  // 真的没图了，任何非空值都是悬空引用，照常收敛
  if (!vals) return;
  if (vals.includes(v) || vals.includes(base)) return;
  w.value = "无";
  if (!vals.includes("无")) vals.unshift("无");
}

// 载入工作流前的预清理 ----------------------------------------------
// onConfigure 里的自检有个时机漏洞：新前端把 widgets_values 应用到控件的动作
// 发生在 onConfigure 之后，而「缺少媒体输入」扫描紧随其后——自检还没来得及
// 看到旧文件名，扫描已经判了缺文件爆红。所以这里抢在图载入之前把序列化数据
// 里的悬空「图片」值预处理成「无」，扫描看到的就是合法值，从根上不再报错。
// 两个入口都挂：beforeConfigureGraph（扩展点，绝大多数加载都经过），
// 以及 loadGraphData 整体包装（最早的一道，覆盖重启后自动恢复上次工作流）。
async function zwnSanitizeGraphData(graphData) {
  if (!graphData || typeof graphData !== "object") return;
  const lists = [graphData.nodes];
  const defs = graphData.definitions || {};
  for (const sg of defs.subgraphs || []) lists.push(sg && sg.nodes);
  for (const list of lists) {
    for (const nd of list || []) {
      if (!nd || !ZWN_CROP_TYPES.has(nd.type)) continue;
      const wv = nd.widgets_values;
      if (wv && typeof wv === "object" && !Array.isArray(wv)) {
        // 新格式：按名字存的对象
        if (typeof wv["图片"] === "string") {
          wv["图片"] = await zwnSanitizePictureValue(wv["图片"]);
        }
        continue;
      }
      if (!Array.isArray(wv)) continue;
      // 老格式：按位置存。「图片」是最后一个文件名样式的字符串；
      // 控件顺序 width/height/x/y/缩放比例/比例选择/模式/图片，兜底第 8 个
      let idx = -1;
      for (let i = wv.length - 1; i >= 0; i--) {
        if (typeof wv[i] === "string"
          && /\.(png|jpe?g|webp|gif|bmp)$/i.test(wv[i].trim())) { idx = i; break; }
      }
      if (idx < 0 && wv.length > 7 && typeof wv[7] === "string") idx = 7;
      if (idx < 0) continue;
      wv[idx] = await zwnSanitizePictureValue(wv[idx]);
    }
  }
}

app.registerExtension({
  name: "ZWNLOVE.PicturePreSanitize",
  async beforeConfigureGraph(graphData) {
    try { await zwnSanitizeGraphData(graphData); } catch (err) {}
  },
  setup() {
    const install = () => {
      if (typeof app.loadGraphData !== "function") return false;
      if (app.__zwnGraphSanitized) return true;
      const orig = app.loadGraphData;
      // 最外层的兜底：loadGraphData 是所有加载路径的总入口
      // （手动打开、重启后恢复上次工作流、切换工作流都走它）
      app.loadGraphData = async function (graphData, ...rest) {
        try { await zwnSanitizeGraphData(graphData); } catch (err) {}
        return orig.call(this, graphData, ...rest);
      };
      app.__zwnGraphSanitized = true;
      return true;
    };
    let tries = 0;
    const tick = () => {
      if (install()) return;
      if (++tries < 20) setTimeout(tick, 500);
    };
    tick();
  },
});

// 悬空「图片」值 -> 「无」：空值、已是「无」直接返回；带注解先剥注解；
// 文件还在就原样保留，探测不到（404）才收敛成「无」
async function zwnSanitizePictureValue(v) {
  const s = String(v ?? "").trim();
  if (!s || s === "无") return "无";
  const base = s.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  if (!base || base === "无") return "无";
  try {
    const ok = await zwnFileExistsOnServer(base);
    if (ok === false) return "无";
  } catch (err) {}
  return v;
}

// 控件值被前端晚于 onConfigure 应用时的兜底：载入后几个时间点再收敛几轮，
// 迟到的旧文件名也会被翻成「无」
function zwnSchedulePictureSweeps(node) {
  for (const d of [400, 1200, 3000]) {
    setTimeout(() => {
      if (node.graph) {
        try { zwnNormalizePictureWidget(node); } catch (err) {}
      }
    }, d);
  }
}

app.registerExtension({
  name: "ZWNLOVE.CropBreakpoint",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || !ZWN_CROP_TYPES.has(nodeData.name)) return;
    const proto = nodeType.prototype;
    const origCreated = proto.onNodeCreated;
    const origConf = proto.onConfigure;
    // 从工作流载入节点走 graph.configure，只触发 onConfigure，
    // 不触发 onNodeCreated；两条路都要挂。控件名可能晚一点才就绪，
    // 没挂上就延时重试几次，成功后打标记避免重复包装。
    const attach = function (retry) {
      if (this.__zwnSendAttached) return;
      let ok = false;
      try { zwnNormalizePictureWidget(this); } catch (err) {}
      try { ok = zwnSetupCropBreakpoint(this); }
      catch (err) { console.warn("[ZWNLOVE] crop breakpoint:", err); }
      if (ok) { this.__zwnSendAttached = true; return; }
      const n = retry || 0;
      // 3 次（1.8s）对慢机器/大工作流偏紧，放宽到 8 次；节点已被删就别再试
      if (n < 8) {
        const self = this;
        setTimeout(() => { if (self.graph) attach.call(self, n + 1); }, 600);
      }
    };
    proto.onNodeCreated = function () {
      const r = origCreated ? origCreated.apply(this, arguments) : undefined;
      attach.call(this, 0);
      zwnSchedulePictureSweeps(this);
      return r;
    };
    proto.onConfigure = function () {
      const r = origConf ? origConf.apply(this, arguments) : undefined;
      attach.call(this, 0);
      zwnSchedulePictureSweeps(this);
      return r;
    };
  },
});

function zwnGetLink(linkId) {
  const links = app.graph?.links;
  if (!links) return null;
  if (typeof links.get === "function") return links.get(linkId) || null;
  return links[linkId] || null;
}

function zwnUpstream(node, slot) {
  const list = node?.inputs || [];
  // image 端子改成 optional 后不一定排在第 0 位，必须按名字找；
  // 位置兜底也只认 IMAGE 类型，免得把接到 width 的 INT 线当成源图。
  const inp = list.find((i) => i && i.name === "image" && i.type === "IMAGE")
    || (list[slot] && list[slot].type === "IMAGE" ? list[slot] : null);
  if (!inp || inp.link == null) return null;
  const l = zwnGetLink(inp.link);
  if (!l) return null;
  const oid = l.origin_id ?? l[1];
  return app.graph.getNodeById?.(oid) || null;
}

// 2 号的 width/height/x/y 被外部 INT 线接管时 widget 名会变成 UNKNOWN，
// 所以按名字找、找不到就退回固定位置（和剪裁面板里同一套兜底）。
function zwnCropParam(crop, name, index) {
  const ws = crop.widgets || [];
  return ws.find((w) => w && w.name === name) || ws[index] || null;
}

function zwnLoadImg(url) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("源图解码失败"));
    im.src = url;
  });
}

// 优先送给自己输出直连的 3 号；没连线（简易版就是这种）就送给画布上所有 3 号。
function zwnFindTargets(node) {
  const graph = app.graph;
  if (!graph) return [];
  const direct = [];
  for (const out of node.outputs || []) {
    for (const lid of out.links || []) {
      const l = zwnGetLink(lid);
      if (!l) continue;
      const t = graph.getNodeById?.(l.target_id ?? l[3]);
      if (t && t.type === "LoadImageGoohai" && !direct.includes(t)) direct.push(t);
    }
  }
  if (direct.length) return direct;
  return (graph._nodes || []).filter((n) => n && n.type === "LoadImageGoohai");
}

// 复刻孤海自己上传按钮做的事：写 COMBO 值 -> callback -> 刷新节点预览。
function zwnApplyToLoadImage(target, value, previewUrl) {
  const tws = target.widgets || [];
  // 工作流刚载入、节点定义还没到位时，widget 名会暂时是 UNKNOWN
  const w = tws.find((x) => x && x.name === "image")
    || tws.find((x) => x && x.type === "combo" && Array.isArray(x.options?.values))
    || tws[0];
  if (!w) return false;
  const vals = w.options?.values;
  if (Array.isArray(vals) && !vals.includes(value)) vals.push(value);
  w.value = value;
  if (!target.properties) target.properties = {};
  target.properties.guhaiImageValue = value;
  try {
    if (typeof w.callback === "function") w.callback(value);
  } catch (err) {
    console.warn("[ZWNLOVE] 3 号 image callback:", err);
  }
  const im = new Image();
  im.onload = () => {
    target.imgs = [im];
    target.imageIndex = null;
    try { target.setDirtyCanvas(true, true); } catch (err) {}
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (err) {}
  };
  im.src = previewUrl;
  try { target.setDirtyCanvas(true, true); } catch (err) {}
  return true;
}

async function zwnSendCrop(node) {
  if (node.__zwnSending) return;
  node.__zwnSending = true;
  try {
    // node 现在就是 2 号本身：加载图、剪裁、断点全在这一个节点里
    const crop = node;

    const num = (name, i, dflt) => {
      const w = zwnCropParam(crop, name, i);
      const n = Number(w && w.value);
      return Number.isFinite(n) ? n : dflt;
    };
    const width = Math.max(1, Math.round(num("width", 0, 512)));
    const height = Math.max(1, Math.round(num("height", 1, 512)));
    const x0 = Math.max(0, Math.round(num("x", 2, 0)));
    const y0 = Math.max(0, Math.round(num("y", 3, 0)));
    const scaleW = (crop.widgets || []).find(
      (w) => w && (w.name === "缩放比例" || w.name === "scale_by"));
    let s = Number(scaleW && scaleW.value);
    if (!Number.isFinite(s) || s <= 0) s = 1;

    const srcW = zwnCropImageWidget(node);
    const raw = String((srcW && srcW.value) || "").trim();
    if (!raw || raw === "无") throw new Error("2 号节点还没有用「图片」控件选图");
    const ann = raw.match(/\[(input|output|temp)\]\s*$/);
    const type = ann ? ann[1] : "input";
    const clean = (ann ? raw.slice(0, ann.index) : raw).replace(/\\/g, "/").trim();
    const parts = clean.split("/");
    const filename = parts.pop();
    const subfolder = parts.join("/");
    const qs = new URLSearchParams({ filename, type, rand: String(Date.now()) });
    if (subfolder) qs.set("subfolder", subfolder);
    const resp = await api.fetchApi("/view?" + qs.toString());
    if (!resp.ok) throw new Error("读取 1 号源图失败 HTTP " + resp.status);
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    let img;
    try { img = await zwnLoadImg(objUrl); }
    finally { URL.revokeObjectURL(objUrl); }

    // 和后端 ZWNLOVE_ImageCrop 同一套越界规则：起点不许出界，右/下越界截断
    const x = Math.min(x0, img.naturalWidth - 1);
    const y = Math.min(y0, img.naturalHeight - 1);
    const sw = Math.min(width, img.naturalWidth - x);
    const sh = Math.min(height, img.naturalHeight - y);
    if (sw < 1 || sh < 1) throw new Error("剪裁框超出源图范围");
    const ow = Math.max(1, Math.round(sw * s));
    const oh = Math.max(1, Math.round(sh * s));
    const cv = document.createElement("canvas");
    cv.width = ow; cv.height = oh;
    const ctx = cv.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, x, y, sw, sh, 0, 0, ow, oh);
    const outBlob = await new Promise((res) => cv.toBlob(res, "image/png"));

    const fd = new FormData();
    fd.append("image", outBlob, "zwn_crop_" + Date.now() + ".png");
    fd.append("type", "input");
    fd.append("overwrite", "false");
    const up = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!up.ok) throw new Error("上传剪裁图失败 HTTP " + up.status);
    const item = await up.json();
    const name = item.name || item.filename;
    const value = (item.subfolder ? item.subfolder + "/" : "") + name + " [input]";
    const pv = new URLSearchParams({ filename: name, type: "input", rand: String(Date.now()) });
    if (item.subfolder) pv.set("subfolder", item.subfolder);
    const previewUrl = api.apiURL("/view?" + pv.toString());

    const targets = zwnFindTargets(node);
    if (!targets.length) throw new Error("画布上没有找到「加载图像 孤海」节点");
    let hit = 0;
    for (const t of targets) if (zwnApplyToLoadImage(t, value, previewUrl)) hit++;
    if (!hit) throw new Error("3 号节点上没有找到 image 文件下拉");
    node.__zwnLastSent = value;
    console.log("[ZWNLOVE] 已把剪裁图送进 " + hit + " 个加载图像节点：" + value);
  } finally {
    node.__zwnSending = false;
  }
}

// 断点模式下「该重送了」的判据：1 号选的图 + 2 号的裁剪参数。
// 不含 3 号自己的值，所以在 3 号上画遮罩、改文件名都不会触发重送。
function zwnSendSignature(node) {
  const sw = zwnCropImageWidget(node);
  const raw = String((sw && sw.value) || "").trim();
  const keys = ["width", "height", "x", "y", "缩放比例", "比例选择"];
  const vals = keys.map((k) => {
    const w = (node.widgets || []).find((x) => x && x.name === k);
    return w ? String(w.value) : "";
  });
  return raw + "|" + vals.join("|");
}

function zwnSetupCropBreakpoint(node) {
  const ws = node.widgets || [];
  // 2 号第 0 个 widget 是 width（INT），绝不能用「退回第一个控件」这种兜底，
  // 否则用户改宽度会误触发送图。只认名字或认「含断点模式选项」的 COMBO。
  const modeW = ws.find((w) => w && w.name === "模式")
    || ws.find((w) => w && w.type === "combo" && Array.isArray(w.options?.values)
      && (w.options.values.includes(ZWN_MODE_LOAD) || w.options.values.includes(ZWN_MODE_LEGACY)));
  if (!modeW) return false;
  // 某些加载时序下 COMBO 会被降级成 text 占位控件，这里恢复成平台原生下拉
  if (modeW.type !== "combo") modeW.type = "combo";
  if (!modeW.options) modeW.options = {};
  if (!Array.isArray(modeW.options.values)) {
    modeW.options.values = [ZWN_MODE_NORMAL, ZWN_MODE_LOAD];
  } else {
    if (!modeW.options.values.includes(ZWN_MODE_NORMAL)) {
      modeW.options.values.unshift(ZWN_MODE_NORMAL);
    }
    // 新名字回来之前（后端没重启），下拉里还是旧名字，别硬塞新值
    const hasAnyLoad = modeW.options.values.some(
      (v) => v === ZWN_MODE_LOAD || v === ZWN_MODE_LEGACY);
    if (!hasAnyLoad) modeW.options.values.push(ZWN_MODE_LOAD);
  }
  // 老工作流回放 widgets_values 时可能塞进空串或旧名字，先收敛一次。
  // 旧名字「断点模式」要翻译成「加载模式」，不能悄悄退化成正常模式。
  zwnNormalizeModeValue(modeW);
  const origCb = modeW.callback;
  let last = String(modeW.value ?? "");
  // 加载工作流时会回放 widget 值，不能把「上次保存时停在断点」误当成用户操作
  node.__zwnArmed = false;

  let sig = zwnSendSignature(node);
  let debounce = null;
  let poll = null;
  const send = (quiet) => {
    zwnSendCrop(node).catch((err) => {
      console.error("[ZWNLOVE] 送图失败:", err);
      if (!quiet) {
        try { alert("自动送图失败：" + (err?.message || err)); } catch (e) {}
      }
    });
  };
  // 加载模式下，只要 1 号的图或 2 号的参数变了，就自动重送一次
  const maybeSend = () => {
    if (!node.__zwnArmed) { sig = zwnSendSignature(node); return; }
    // 正在送时什么都不做，也不吞掉这次变化，留到下一轮再比
    if (node.__zwnSending) return;
    if (!zwnIsLoadMode(modeW)) {
      sig = zwnSendSignature(node);
      return;
    }
    const s = zwnSendSignature(node);
    if (s === sig) return;
    sig = s;
    if (debounce) clearTimeout(debounce);
    // 拖红框、连点参数会连发，合并成一次上传
    debounce = setTimeout(() => { debounce = null; send(true); }, 260);
  };
  const startPoll = () => { if (!poll) poll = setInterval(maybeSend, 500); };
  const stopPoll = () => { if (poll) { clearInterval(poll); poll = null; } };

  // 主路径：1 号换图、2 号改参数都会走 widget callback，各只包一次
  const wrap = (w) => {
    if (!w || w.__zwnSendWatched) return;
    const oc = w.callback;
    w.__zwnSendWatched = true;
    w.callback = function () {
      const r = oc ? oc.apply(this, arguments) : undefined;
      maybeSend();
      return r;
    };
  };
  const watchAll = () => {
    wrap(zwnCropImageWidget(node));
    for (const w of node.widgets || []) {
      if (w && ["width", "height", "x", "y", "缩放比例", "比例选择"].includes(w.name)) wrap(w);
    }
  };
  watchAll();
  // 兜底：有些路径直接改 widget.value 不调 callback（上传回填、拖框等）。
  // 只在加载模式开一个轻量轮询，正常模式完全不跑。
  const arm = () => setTimeout(() => {
    watchAll();   // 工作流载入时 1 号可能比 2 号晚建好，这里再认一次
    // widgets_values 的回放可能晚于 onConfigure，等它落定后再收敛一次模式值，
    // 否则旧名字会留在控件里，提交时被 COMBO 校验拦掉
    zwnNormalizeModeValue(modeW);
    last = String(modeW.value ?? "");
    node.__zwnArmed = true;
    sig = zwnSendSignature(node);
    if (zwnIsLoadMode(modeW)) startPoll();
  }, 350);
  const origConf = node.onConfigure;
  node.onConfigure = function () {
    const r = origConf ? origConf.apply(this, arguments) : undefined;
    node.__zwnArmed = false;
    zwnNormalizeModeValue(modeW);
    last = String(modeW.value ?? "");
    stopPoll();
    arm();
    return r;
  };
  // 节点被删/工作流被关掉时必须停掉 500ms 轮询和未触发的 debounce，
  // 否则定时器会一直空转（原实现没有 onRemoved，属于泄漏）
  const origRemoved = node.onRemoved;
  node.onRemoved = function () {
    stopPoll();
    if (debounce) { clearTimeout(debounce); debounce = null; }
    node.__zwnArmed = false;
    try { node.__zwnCropRO?.disconnect?.(); } catch (err) {}
    node.__zwnCropRO = null;
    return origRemoved ? origRemoved.apply(this, arguments) : undefined;
  };
  arm();
  modeW.callback = function (v) {
    const r = origCb ? origCb.apply(this, arguments) : undefined;
    const cur = typeof v === "string" && v ? v : String(modeW.value ?? "");
    const isLoad = cur === ZWN_MODE_LOAD || cur === ZWN_MODE_LEGACY;
    const wasLoad = last === ZWN_MODE_LOAD || last === ZWN_MODE_LEGACY;
    if (node.__zwnArmed && isLoad && !wasLoad) {
      // 手动切进加载模式：立刻送一次，同时重置基线，免得轮询再送一遍
      sig = zwnSendSignature(node);
      send(false);
      startPoll();
    } else if (!isLoad) {
      stopPoll();
      if (debounce) { clearTimeout(debounce); debounce = null; }
      sig = zwnSendSignature(node);
    }
    last = cur;
    return r;
  };
  return true;
}
/* 加载模式：提交前把「图像输入」这根线摘掉 ---------------------------------
   线留在画布上（看得见、存得下），只在 prompt 组装完之后把目标节点的
   「图像输入」键删掉。后端收到 None → 走文件分支，遮罩照旧从笔刷 alpha 算，
   不会再出现「全 0 遮罩 → 补成全选 → 被纯色盖满」。
   下游不吃这个输出，裁剪节点自然被剪枝，不会白跑一遍。
   切回正常模式，同一个包装立刻放行，线恢复生效 —— 用户不用手动加线删线。 */
app.registerExtension({
  name: "ZWNLOVE.LoadModeLinkGuard",
  setup() {
    const install = () => {
      if (!app || typeof app.graphToPrompt !== "function") return false;
      if (app.__zwnLinkGuard) return true;
      const orig = app.graphToPrompt;
      // graphToPrompt 返回 { workflow, output }，output 就是提交给 /prompt 的图
      app.graphToPrompt = async function (...args) {
        // 提交前再收敛一次悬空的「图片」引用：工作流开着的时候 input 目录
        // 可能被清理，运行前的缺失媒体扫描会拿旧文件名卡运行
        try {
          for (const n of app.graph?._nodes || []) {
            if (n && ZWN_CROP_TYPES.has(n.type)) zwnNormalizePictureWidget(n);
          }
        } catch (err) {}
        const r = await orig.apply(this, args);
        try {
          const n = zwnStripLoadModeLinks(r && r.output);
          if (n) console.log("[ZWNLOVE] 加载模式：提交时摘掉 " + n + " 条「图像输入」连线");
        } catch (err) {
          console.warn("[ZWNLOVE] link guard:", err);
        }
        return r;
      };
      // 手动刷新节点下拉（refreshComboInNode / 右键 refresh）后，选项列表
      // 按当前 input 目录重建，悬空引用这时候才暴露出来；刷新完再收敛一次
      if (typeof app.refreshComboInNode === "function" && !app.__zwnComboRefreshGuard) {
        app.__zwnComboRefreshGuard = true;
        const origRefresh = app.refreshComboInNode;
        app.refreshComboInNode = async function (...args) {
          const r = await origRefresh.apply(this, args);
          try {
            for (const n of app.graph?._nodes || []) {
              if (!n) continue;
              if (ZWN_CROP_TYPES.has(n.type)) zwnNormalizePictureWidget(n);
              if (n.type === ZWN_GOOHAI_LOAD_TYPE) zwnScheduleGoohaiStaleCleanup(n, 300);
            }
          } catch (err) {}
          return r;
        };
      }
      app.__zwnLinkGuard = true;
      return true;
    };
    // 只重试一次的话，setup 时 app 还没就绪就永久失效了；多试几轮更稳
    let tries = 0;
    const tryInstall = () => {
      if (install()) return;
      if (++tries < 20) setTimeout(tryInstall, 500);
      else console.warn("[ZWNLOVE] graphToPrompt 包装失败：加载模式下连线不会被摘掉");
    };
    tryInstall();
  }
});

/* ==================================================================
   孤海「加载图像」节点（LoadImageGoohai）的悬空图片记录清理。
   遮罩编辑器保存时会把原图/蒙版/输出三张图传进 input/clipspace/，
   并把输出图路径写进节点 properties（guhaiImageValue 等）和下拉选项
   列表（纯前端内存）。这些文件被清理后两处都不会跟着同步，重载时
   孤海还会用 properties 里的旧路径把值「复活」回来，于是下拉里永远
   挂着一条指向已删除文件的记录。这里在载入/刷新下拉后逐个到后端
   /view 探测：文件确实不在了，值复位成「无」、选项从列表里摘掉。
   真实上传的图片和仍然存在的 clipspace 产物一律不碰。
   ================================================================== */
const ZWN_GOOHAI_LOAD_TYPE = "LoadImageGoohai";
// 只针对「过程产物」路径：clipspace 子目录、裁剪缓存、遮罩中间产物
const ZWN_TRANSIENT_VALUE_RE = /clipspace\/|zwn_crop_|painted-/;

function zwnParseImageValue(v) {
  const s = String(v ?? "").trim();
  const m = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(s);
  const base = m ? m[1] : s;
  const type = m && m[2] ? m[2] : "input";
  const parts = base.split("/");
  const filename = parts.pop();
  return { filename, subfolder: parts.join("/"), type };
}

function zwnFileExistsOnServer(v) {
  const p = zwnParseImageValue(v);
  const url = "/view?filename=" + encodeURIComponent(p.filename)
    + "&type=" + encodeURIComponent(p.type || "input")
    + "&subfolder=" + encodeURIComponent(p.subfolder || "");
  return fetch(url).then((r) => {
    if (r.ok) return true;
    if (r.status === 404) return false;
    return null; // 其他状态码当「未知」，宁可不动作
  }).catch(() => null);
}

function zwnCleanGoohaiStale(node) {
  const w = (node.widgets || []).find((x) => x && x.name === "image");
  if (!w) return;
  const vals = Array.isArray(w.options && w.options.values) ? w.options.values : null;
  const targets = [];
  const cur = String(w.value ?? "");
  if (cur && cur !== "无" && ZWN_TRANSIENT_VALUE_RE.test(cur)) targets.push(cur);
  if (vals) {
    for (const v of vals) {
      if (typeof v === "string" && v !== "无" && ZWN_TRANSIENT_VALUE_RE.test(v)
        && !targets.includes(v)) targets.push(v);
    }
  }
  if (!targets.length) return;
  Promise.all(targets.map((v) => zwnFileExistsOnServer(v).then((ok) => [v, ok])))
    .then((pairs) => {
      const gone = pairs.filter(([, ok]) => ok === false).map(([v]) => v);
      if (!gone.length) return;
      let changed = false;
      if (gone.includes(String(w.value ?? ""))) {
        w.value = "无";
        if (node.properties) node.properties.guhaiImageValue = "无";
        changed = true;
      }
      if (vals) {
        const next = vals.filter((v) => !gone.includes(v));
        if (next.length !== vals.length) {
          vals.length = 0;
          vals.push(...next);
          changed = true;
        }
      }
      if (changed) {
        node.setDirtyCanvas?.(true, true);
        app.graph?.change?.();
        console.log("[ZWNLOVE] 已清理指向已删除文件的图片记录:", gone.join(", "));
      }
    });
}

function zwnScheduleGoohaiStaleCleanup(node, delay) {
  setTimeout(() => {
    if (node.graph) {
      try { zwnCleanGoohaiStale(node); } catch (err) {}
    }
  }, delay || 1200);
}

app.registerExtension({
  name: "ZWNLOVE.GoohaiStaleCleanup",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== ZWN_GOOHAI_LOAD_TYPE) return;
    const proto = nodeType.prototype;
    const origConf = proto.onConfigure;
    const origCreated = proto.onNodeCreated;
    proto.onConfigure = function () {
      const r = origConf ? origConf.apply(this, arguments) : undefined;
      // 孤海自己的 onConfigure 会拿 properties 里的旧路径复活值，
      // 等它跑完再探测清理，延时排到它后面
      zwnScheduleGoohaiStaleCleanup(this);
      return r;
    };
    proto.onNodeCreated = function () {
      const r = origCreated ? origCreated.apply(this, arguments) : undefined;
      zwnScheduleGoohaiStaleCleanup(this);
      return r;
    };
  },
});

// SEND_SWITCH_END

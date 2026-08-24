// @dsh/message-enhancer - browser half.
//
// Four additive client surfaces in one plugin:
// 1. conversation.input.dock: vertical index of user messages and plans
//    (original message-enhancer feature; the chat flow stays the owner of
//    rendering, scrolling, and loading older history).
// 2. conversation.composer + tool.call.toolview: plan review card and
//    exit_plan_mode history card (absorbed from @dsh/plan-review-card; the
//    host protocol remains unchanged, this package owns presentation only).
// 3. settings.general.item + conversation.input.dock: reply-completion
//    sound/system-notification preferences and a session-scoped watcher.
// 4. conversation.message (DOM-injected) + conversation.input.dock:
//    inline edit-and-resend of the last user message — an edit button
//    injected into the last user bubble's action row (left of the copy
//    icon; the user bubble has no native action slot) turns the bubble
//    into an editor; saving forks a child session at the completed turn
//    before that message (api.sessions.fork), switches to it, sends the
//    revised text (model answers fresh, the old reply never appears) and
//    archives the original session (workspace.archiveSession; DSH has no
//    in-place edit — session logs are append-only).

window.__ModuleLoader__.load({
  id: "@dsh/message-enhancer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    let ReactDOM = null;
    try {
      ReactDOM = require("react-dom");
    } catch {}
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const STYLE_TAG = "@dsh/message-enhancer/styles";

    // ============================================================
    // 共享工具：解析 exit_plan_mode 工具调用的 argsRaw 中的计划文本。
    // 索引标尺与计划历史卡共用，避免两份重复的 JSON 解析实现。
    // 返回 trim 后的 plan 字符串；argsRaw 缺失、非法 JSON 或计划为空时返回 null。
    // ============================================================
    function parsePlanArgsRaw(argsRaw) {
      if (typeof argsRaw !== "string" || argsRaw === "") return null;
      try {
        const parsed = JSON.parse(argsRaw);
        if (!parsed || typeof parsed.plan !== "string") return null;
        const plan = parsed.plan.trim();
        return plan === "" ? null : plan;
      } catch (error) {
        return null;
      }
    }

    // 原 message-enhancer 曾要求计划正文以 "# 标题" 开头才进入索引刻度；
    // 该限制已移除——DSH 实际计划文本非 "# " 开头，会挡住全部计划节点，见 planFromToolNode。

    // ============================================================
    // 功能一：输入框旁的用户消息与计划索引标尺（原 message-enhancer）
    // ============================================================

    // 提取工具结果文本（content 可能是文本块数组或字符串），用于区分结算方式。
    function toolResultText(root) {
      if (Array.isArray(root.content)) {
        return root.content.map((entry) => (entry && typeof entry.text === "string" ? entry.text : "")).join("");
      }
      return typeof root.content === "string" ? root.content : "";
    }

    // 原实现要求计划正文以 "# 标题" 开头才进入索引刻度（已移除：该限制与
    // 实际数据无关，且曾挡住非 "# " 开头的计划；日志证实 DSH 计划以 "# " 开头，
    // 保留与否均不影响）。与历史卡一致：只要 plan 文本非空即识别。
    function planFromToolNode(node) {
      if (!node || node.kind !== "tool-call" || !node.data || !node.data.root) return null;
      const root = node.data.root;
      if (root.name === "exit_plan_mode") {
        const plan = parsePlanArgsRaw(root.argsRaw);
        return plan !== null ? { plan, status: "pending" } : null;
      }
      if (root.kind === "tool-result" && root.call && root.call.name === "exit_plan_mode") {
        const plan = parsePlanArgsRaw(root.call.argsRaw);
        if (plan === null) return null;
        // 非错误即已接受（绿）。
        if (root.isError !== true) return { plan, status: "accepted" };
        // isError 为 true 时，三种拒绝路径在工具结果文本上可区分：
        // "dismissed ... to speak instead" = 去聊天里说（取消评审）；
        // "their feedback: ..." = 填反馈提交；其余 keep planning = 空拒绝。
        // 该文案为 host 固定英文输出，宽松匹配；若 host 变更文案会退化到
        // 兜底的 rejected（语义安全：最接近"未批准"）。
        const contentText = toolResultText(root);
        if (/dismissed/i.test(contentText)) return { plan, status: "cancelled" };
        if (/feedback/i.test(contentText)) return { plan, status: "feedback" };
        return { plan, status: "rejected" };
      }
      return null;
    }

    function extractIndexItems(snapshot) {
      if (!snapshot || !snapshot.chat || !snapshot.chat.nodes || typeof snapshot.chat.nodes.values !== "function") return [];
      const items = [];
      snapshot.chat.nodes.values().forEach((node) => {
        if (!node) return;
        const data = node.data || {};
        if (node.kind === "user" || node.kind === "steering") {
          items.push({
            key: String(node.key),
            seq: typeof node.anchorSeq === "number" ? node.anchorSeq : (typeof data.seq === "number" ? data.seq : 0),
            time: data.time,
            type: "message",
            fullText: toText(data.content),
          });
          return;
        }
        const plan = planFromToolNode(node);
        if (plan !== null) {
          items.push({
            key: String(node.key),
            seq: typeof node.anchorSeq === "number" ? node.anchorSeq : 0,
            time: data.time || (data.root && data.root.time),
            type: "plan",
            status: plan.status,
            fullText: plan.plan,
          });
        }
      });
      return items.sort((left, right) => left.seq - right.seq);
    }

    function toText(blocks) {
      if (!Array.isArray(blocks)) return "";
      return blocks.map((block) => {
        if (!block || typeof block !== "object") return "";
        if (block.type === "text") return typeof block.text === "string" ? block.text : "";
        if (block.type === "image") return "[图片]";
        return "[其他内容]";
      }).filter(Boolean).join("\n");
    }

    function formatTime(ms) {
      try {
        if (typeof Date === "undefined" || typeof ms !== "number") return "";
        return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } catch (error) {
        return "";
      }
    }

    function jumpToMessage(event, key) {
      if (key === "") return false;
      const source = event.currentTarget;
      if (!source || typeof source.closest !== "function") return false;
      const scrollBody = source.closest("[data-conversation-scroll]");
      if (!scrollBody || typeof scrollBody.querySelectorAll !== "function") return false;
      const rows = scrollBody.querySelectorAll("[data-chat-anchor-key]");
      let target = null;
      for (let index = 0; index < rows.length; index += 1) {
        if (rows[index].getAttribute("data-chat-anchor-key") === key) {
          target = rows[index];
          break;
        }
      }
      if (target === null) return false;
      const bodyRect = scrollBody.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const composer = scrollBody.querySelector("[data-composer-seat]");
      const visibleBottom = composer === null ? bodyRect.bottom : composer.getBoundingClientRect().top;
      const visibleHeight = Math.max(0, visibleBottom - bodyRect.top);
      const desiredTop = bodyRect.top + Math.max(16, (visibleHeight - targetRect.height) / 2);
      scrollBody.scrollTop += targetRect.top - desiredTop;
      return true;
    }

    // 定位 ChatView 的"加载更早"分页按钮。已知契约：该按钮位于 flow 列顶部，
    // 且不属于任何聊天消息行（消息行带 data-chat-anchor-key）。宿主若在顶部插入
    // 其他装饰元素，跳过它们后仍能找到按钮，比固定取 :first-child 更稳。
    function findOlderButton(scrollBody) {
      const flow = scrollBody.querySelector("[data-chat-flow]");
      if (flow === null || typeof flow.children !== "object") return null;
      for (let index = 0; index < flow.children.length; index += 1) {
        const child = flow.children[index];
        if (!child || child.getAttribute("data-chat-anchor-key") !== null) continue;
        const button = typeof child.querySelector === "function" ? child.querySelector("button") : null;
        if (button !== null) return button;
      }
      return null;
    }

    function requestOlder(event) {
      const source = event.currentTarget;
      if (!source || typeof source.closest !== "function") return;
      const scrollBody = source.closest("[data-conversation-scroll]");
      if (!scrollBody || typeof scrollBody.querySelector !== "function") return;
      const olderButton = findOlderButton(scrollBody);
      if (olderButton && !olderButton.disabled && typeof olderButton.click === "function") olderButton.click();
    }

    function useTrajectoryHidden() {
      const [hidden, setHidden] = React.useState(false);
      React.useEffect(() => {
        if (typeof document === "undefined" || document.body === null) return undefined;

        const readActiveView = () => {
          // The dock is not guaranteed to be inside the composer phase node.
          // Read the actual tablists from the document so this keeps working
          // after the dock mounts, session changes, and tab rerenders.
          const tabLists = document.querySelectorAll('[role="tablist"]');
          let trajectoryActive = false;
          for (let listIndex = 0; listIndex < tabLists.length; listIndex += 1) {
            const tabs = tabLists[listIndex].querySelectorAll('[role="tab"]');
            if (tabs.length > 1 && tabs[1].getAttribute("aria-selected") === "true") {
              trajectoryActive = true;
              break;
            }
          }
          setHidden(trajectoryActive);
        };

        readActiveView();
        if (typeof MutationObserver === "undefined") return undefined;
        // 聊天流式输出会在 body 子树产生高频 childList 变更，若每次都全量扫描
        // tablist 会浪费主线程。aria-selected 属性变化（真正的 Tab 切换）立即处理；
        // 结构性变化按帧合并，最多每帧扫描一次。
        let frame = 0;
        const scheduleRead = () => {
          if (frame !== 0) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            readActiveView();
          });
        };
        const observer = new MutationObserver((mutations) => {
          const hasAttributeChange = mutations.some((mutation) => mutation.type === "attributes");
          if (hasAttributeChange) {
            if (frame !== 0) {
              cancelAnimationFrame(frame);
              frame = 0;
            }
            readActiveView();
            return;
          }
          scheduleRead();
        });
        observer.observe(document.body, {
          subtree: true,
          attributes: true,
          childList: true,
          attributeFilter: ["aria-selected"],
        });
        return () => {
          observer.disconnect();
          if (frame !== 0) cancelAnimationFrame(frame);
        };
      }, []);
      return hidden;
    }

    // Lightweight inline renderer: **bold** and `code` only. No external deps.
    function renderInline(text, keyPrefix) {
      const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
      const nodes = [];
      let last = 0;
      let match = null;
      let index = 0;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        const token = match[0];
        if (token.startsWith("**")) {
          nodes.push(React.createElement("strong", { key: keyPrefix + "-b" + index }, token.slice(2, -2)));
        } else {
          nodes.push(React.createElement("code", { key: keyPrefix + "-c" + index }, token.slice(1, -1)));
        }
        index += 1;
        last = match.index + token.length;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }

    // Line-based mini markdown: # headings, -/*/+ lists, paragraphs.
    function renderPreviewBody(fullText) {
      if (typeof fullText !== "string" || fullText === "") return ["[无文本内容]"];
      const lines = fullText.split(/\r?\n/);
      const blocks = [];
      let listItems = null;
      let key = 0;
      const flushList = () => {
        if (listItems !== null) {
          blocks.push(React.createElement("ul", { key: "list" + key, className: "meh-preview-list" }, listItems));
          listItems = null;
        }
      };
      lines.forEach((rawLine) => {
        const line = rawLine.trim();
        if (line === "") {
          flushList();
          return;
        }
        const heading = /^#{1,6}\s+/.exec(line);
        if (heading !== null) {
          flushList();
          blocks.push(React.createElement("div", {
            key: "h" + key,
            className: "meh-preview-heading",
          }, renderInline(line.slice(heading[0].length), "h" + key)));
          key += 1;
          return;
        }
        const listMark = /^[-*+]\s+/.exec(line);
        if (listMark !== null) {
          if (listItems === null) listItems = [];
          listItems.push(React.createElement("li", {
            key: "li" + key,
          }, renderInline(line.slice(listMark[0].length), "li" + key)));
          key += 1;
          return;
        }
        flushList();
        blocks.push(React.createElement("div", {
          key: "p" + key,
          className: "meh-preview-para",
        }, renderInline(line, "p" + key)));
        key += 1;
      });
      flushList();
      return blocks;
    }

    function planStatusText(status) {
      return status === "accepted" ? "已接受"
        : status === "rejected" ? "已拒绝"
        : status === "feedback" ? "已反馈"
        : status === "cancelled" ? "已取消"
        : "待处理";
    }

    // 波浪宽度：中心刻度（悬浮/选中）保持 34px（沿用此前选中态的宽度），
    // 相邻每级递减 5px，递减下限为默认宽度 9px（刻度永不窄于默认宽度），
    // 配合 .meh-tick:before 的 width 过渡（0.08s）形成向两侧扩散的波浪动画。
    // 参数（中心宽/默认宽/步长）可按视觉偏好调整。
    function waveTickWidth(distance) {
      return Math.max(6, 34 - distance * 5);
    }

    function UserMessageRuler(props) {
      const rulerRef = React.useRef(null);
      const [hoverKey, setHoverKey] = React.useState(undefined);
      // 预览卡绝对定位在刻度右侧（left:48px），与刻度间存在空隙：鼠标从刻度
      // 滑向卡片时若立即清除 hover 会闪断。改为延迟隐藏（120ms），期间进入
      // 预览卡则由卡片自身 onMouseEnter 重新锁定，避免"鼠标还没到卡片就消失"。
      const hideTimer = React.useRef(null);
      React.useEffect(() => () => {
        if (hideTimer.current !== null) clearTimeout(hideTimer.current);
      }, []);
      // 预览卡固定从刻度上方 8px 向下展开（CSS top:-8px），靠近视口上下边缘时
      // 按可用空间收紧高度，避免被视口裁剪；内容仍可在卡内滚动。
      const [previewMaxHeight, setPreviewMaxHeight] = React.useState(260);
      const hiddenByTrajectory = useTrajectoryHidden();
      // 分开订阅两个布尔值：选择器返回原始值，避免宿主 useSession 按引用比较快照时
      // 因每次返回新对象字面量而进入无限重渲染。
      const hasMore = typeof props.useSession === "function"
        ? props.useSession((snapshot) => snapshot.hasMore === true)
        : false;
      const loadingOlder = typeof props.useSession === "function"
        ? props.useSession((snapshot) => snapshot.loadingOlder === true)
        : false;
      // hover/选中状态变化也会触发重渲染，而标尺解析需遍历全部节点并 JSON.parse
      // 计划 argsRaw，必须按 session 记忆化，避免每次悬浮都全量重算。
      const items = React.useMemo(() => extractIndexItems(props.session), [props.session]);
      if (items.length === 0) return null;

      // 波浪中心仅由悬浮驱动：点击跳转不保留选中态，鼠标移开后波浪收回默认宽度。
      const waveCenterKey = hoverKey;
      const waveCenterIndex = waveCenterKey === undefined
        ? -1
        : items.findIndex((item) => item.key === waveCenterKey);

      // 悬浮/聚焦时按刻度位置收紧预览卡高度：上下各留 8px 安全边距，
      // 保底 120px 保证极端位置下预览仍可用。
      const openPreview = (event, key) => {
        if (hideTimer.current !== null) {
          clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
        const tick = event.currentTarget;
        if (typeof tick.getBoundingClientRect !== "function") {
          setHoverKey(key);
          return;
        }
        const previewTop = tick.getBoundingClientRect().top - 8;
        const available = Math.min(previewTop - 8, window.innerHeight - previewTop - 8);
        setPreviewMaxHeight(Math.max(120, Math.min(260, available)));
        setHoverKey(key);
      };

      // 延迟隐藏：鼠标离开刻度后给 120ms 容错，期间若进入预览卡则取消隐藏。
      const scheduleHide = () => {
        if (hideTimer.current !== null) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => {
          hideTimer.current = null;
          setHoverKey(undefined);
        }, 120);
      };

      return React.createElement("div", {
        ref: rulerRef,
        className: "meh-ruler",
        "aria-label": "用户消息与计划索引",
        style: hiddenByTrajectory ? { display: "none" } : undefined,
      },
        hasMore ? React.createElement("button", {
          type: "button",
          className: "meh-older" + (loadingOlder ? " meh-older-loading" : ""),
          "aria-label": loadingOlder ? "正在加载更早消息" : "加载更早消息",
          disabled: loadingOlder,
          onClick: requestOlder,
        }, loadingOlder ? "…" : "···") : null,
        items.map((item, index) => {
          const isHovered = hoverKey === item.key;
          const statusClass = item.type === "plan" ? " meh-plan-" + item.status : "";
          const className = "meh-tick meh-tick-" + item.type + statusClass + (isHovered ? " meh-tick-hovered" : "");
          // 波浪宽度：距中心每远一级递减 5px；无悬浮中心时不设宽度（回退 CSS 默认 9px）。
          const distance = waveCenterIndex < 0 ? -1 : Math.abs(index - waveCenterIndex);
          const tickStyle = distance < 0 ? undefined : { "--meh-tick-w": waveTickWidth(distance) + "px" };
          return React.createElement("button", {
            key: item.key || String(item.seq),
            type: "button",
            className,
            style: tickStyle,
            "aria-label": (item.type === "plan" ? "计划 · " + planStatusText(item.status) : "消息") + "，跳转到第 " + String(index + 1) + " 项",
            onClick: (event) => {
              jumpToMessage(event, item.key);
            },
            onMouseEnter: (event) => openPreview(event, item.key),
            onMouseLeave: scheduleHide,
            onFocus: (event) => openPreview(event, item.key),
            onBlur: () => {
              if (hideTimer.current !== null) {
                clearTimeout(hideTimer.current);
                hideTimer.current = null;
              }
              setHoverKey(undefined);
            },
          }, isHovered ? React.createElement("div", {
            className: "meh-preview",
            style: { maxHeight: previewMaxHeight + "px" },
            onMouseEnter: () => {
              // 从刻度滑入预览卡时取消延迟隐藏，卡片保持显示。
              if (hideTimer.current !== null) {
                clearTimeout(hideTimer.current);
                hideTimer.current = null;
              }
            },
            onMouseLeave: scheduleHide,
          },
            React.createElement("div", { className: "meh-preview-body" }, renderPreviewBody(item.fullText)),
            React.createElement("div", { className: "meh-preview-meta" },
              React.createElement("span", null, item.type === "plan" ? "计划 · " + planStatusText(item.status) : "消息"),
              formatTime(item.time) === "" ? null : React.createElement("span", null, formatTime(item.time)),
            ),
          ) : null);
        }),
      );
    }

    const RULER_CSS = [
      "[data-conversation-scroll]{position:relative;anchor-name:--meh-chat-body}",
      ".meh-ruler{box-sizing:border-box;position:absolute;left:8px;top:50%;transform:translateY(-50%);z-index:60;display:flex;flex-direction:column;align-items:flex-start;gap:1px;pointer-events:auto}",
      "@supports (anchor-name:--meh-chat-body){.meh-ruler{position:fixed;position-anchor:--meh-chat-body;left:calc(anchor(left) + 8px);top:anchor(center)}}",
      ".meh-ruler:before{content:\"\";position:absolute;left:2px;top:5px;bottom:5px;width:1px;background:var(--dsw-alias-border-l1);pointer-events:none}",
      ".meh-older{appearance:none;box-sizing:border-box;position:relative;width:44px;height:14px;margin:0;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-caption);font-size:11px;line-height:14px;letter-spacing:2px;text-align:left;cursor:pointer;z-index:1}",
      ".meh-older:hover:not(:disabled),.meh-older:focus-visible{color:var(--dsw-alias-label-secondary);outline:none}",
      ".meh-older-loading{cursor:wait;opacity:.7}",
      ".meh-tick{appearance:none;box-sizing:border-box;position:relative;width:50px;height:10px;min-width:0;min-height:0;margin:0;padding:0;border:0;background:transparent;cursor:pointer;overflow:visible;z-index:1}",
      ".meh-tick:before{content:\"\";position:absolute;left:0;top:3px;width:var(--meh-tick-w,6px);height:2px;border-radius:2px;background:#a3a6a9;opacity:1;transition:width .08s ease,background-color .14s ease,opacity .14s ease}",
      ".meh-tick-plan:before{background:#f59e0b}",
      ".meh-plan-accepted:before{background:#22c55e}",
      ".meh-plan-rejected:before{background:#f14646}",
      "/* 悬浮/聚焦不再放大尺寸：宽度由波浪 --meh-tick-w 控制，高度恒为 4px，仅颜色变化保持状态辨识度 */",
      ".meh-tick:hover:before,.meh-tick:focus-visible:before,.meh-tick-hovered:before{background:#242424;opacity:1}",
      ".meh-tick-plan:hover:before,.meh-tick-plan:focus-visible:before,.meh-tick-plan-hovered:before{background:#f59e0b}",
      ".meh-plan-accepted:hover:before,.meh-plan-accepted:focus-visible:before,.meh-plan-accepted.meh-tick-hovered:before{background:#22c55e}",
      ".meh-plan-rejected:hover:before,.meh-plan-rejected:focus-visible:before,.meh-plan-rejected.meh-tick-hovered:before{background:#f14646}",
      ".meh-tick:focus-visible:after{content:\"\";position:absolute;left:-3px;top:0;width:46px;height:10px;border:1px solid var(--dsw-alias-label-secondary);border-radius:6px}",
      ".meh-preview{position:absolute;left:48px;top:-8px;width:320px;max-height:260px;overflow:auto;text-align:left;background:#fff;border:0;border-radius:10px;box-shadow:0 12px 28px rgba(0,0,0,.12),0 2px 6px rgba(0,0,0,.06);padding:10px 12px;z-index:70}",
      ".meh-preview-body{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      ".meh-preview-heading{font-weight:600;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}",
      ".meh-preview-para{white-space:pre-wrap;word-break:break-word}",
      ".meh-preview-list{margin:0;padding-left:14px;white-space:pre-wrap;word-break:break-word}",
      ".meh-preview-list li{list-style:disc}",
      ".meh-preview code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;padding:0 2px;border-radius:3px;background:rgba(0,0,0,.05)}",
      ".meh-preview-meta{display:flex;justify-content:space-between;gap:8px;margin-top:6px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary)}",
    ];

    // ============================================================
    // 功能二：计划审批卡与 exit_plan_mode 历史卡（并入自 @dsh/plan-review-card）
    // ============================================================

    const NS = "plan-review-card";
    const EXPANDED_TOP_RESERVE = 88;

    const zh = {
      "header": "计划待审",
      "historyHeader": "计划记录",
      "historyUnavailable": "计划内容尚未加载。",
      "generating": "正在生成计划…",
      "copy": "复制计划",
      "copied": "已复制",
      "copyFailed": "复制失败，请重试。",
      "expand": "展开计划",
      "collapse": "收起计划",
      "expandWindow": "放大窗口",
      "collapseWindow": "收起窗口",
      "discuss": "去聊天里说",
      "decline": "拒绝",
      "submitFeedback": "提交反馈",
      "feedbackPlaceholder": "输入需要调整的地方，Enter 提交反馈…",
      "resultRejected": "已退回修改，模型将根据反馈继续规划。",
      "resultApproved": "计划已确认执行。",
      "acceptedPlan": "用户接收的计划",
      "approve": "确认执行",
    };

    const en = {
      "header": "Plan review",
      "historyHeader": "Plan record",
      "historyUnavailable": "Plan content is not loaded yet.",
      "generating": "Generating plan…",
      "copy": "Copy plan",
      "copied": "Copied",
      "copyFailed": "Copy failed. Try again.",
      "expand": "Expand plan",
      "collapse": "Collapse plan",
      "expandWindow": "Enlarge view",
      "collapseWindow": "Close view",
      "discuss": "Chat about it",
      "decline": "Refuse",
      "submitFeedback": "Send feedback",
      "feedbackPlaceholder": "Describe what to adjust — Enter sends the feedback…",
      "resultRejected": "Returned for revision; the model will continue planning from the feedback.",
      "resultApproved": "Plan approved for execution.",
      "acceptedPlan": "Accepted plan",
      "approve": "Approve",
    };

    const REVIEW_CSS = [
      ".prcard-frame{box-sizing:border-box;display:flex;justify-content:center;padding:6px calc(var(--dsh-composer-side-clearance,16px) + 16px) 10px}",
      ".prcard-card{box-sizing:border-box;display:flex;flex-direction:column;width:100%;max-width:var(--dsh-chat-content-width,748px);max-height:min(60vh,520px);overflow:hidden;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(128,128,128,.24));border-radius:20px;background:var(--dsw-specific-input-major,#fff);box-shadow:var(--dsw-shadow-lv2,0 4px 16px rgba(0,0,0,.12));color:var(--dsw-alias-label-primary,#1f2329);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.28));--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2,rgba(128,128,128,.42));transition:height .18s ease,max-height .18s ease}",
      ".prcard-card,.prcard-card *,.prcard-history,.prcard-history *{box-sizing:border-box}",
      ".prcard-history{position:relative;display:flex;flex-direction:column;width:100%;height:300px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(128,128,128,.24));border-radius:8px;background:var(--dsw-specific-input-major,#fff);color:var(--dsw-alias-label-primary,#1f2329);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.28));--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2,rgba(128,128,128,.42))}",
      ".prcard-history-unavailable{display:flex;align-items:center;min-height:40px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));border-radius:8px;background:var(--dsw-specific-input-major,#fff);color:var(--dsw-alias-label-tertiary,#8a8f99);font-size:12px;line-height:20px}",
      ".prcard-handle-row{display:flex;flex:none;align-items:center;justify-content:center;height:20px;padding-top:3px}",
      ".prcard-handle{display:grid;place-items:center;width:48px;height:18px;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;outline:none}",
      ".prcard-handle::before{content:\"\";display:block;width:30px;height:4px;border-radius:2px;background:var(--dsw-alias-border-l3,rgba(128,128,128,.38));transition:background .12s,transform .12s}",
      ".prcard-handle:hover::before{background:var(--dsw-alias-label-caption,#8a8f99)}",
      ".prcard-handle:active::before{transform:scaleX(.88)}",
      ".prcard-handle:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3,rgba(128,128,128,.38))}",
      ".prcard-header{display:flex;flex:none;align-items:center;justify-content:space-between;gap:12px;padding:1px 12px 8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}",
      ".prcard-history .prcard-header,.prcard-expanded-panel .prcard-header{padding-top:10px;padding-bottom:10px}",
      ".prcard-title{min-width:0;flex:1;overflow:hidden;color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;font-weight:500;line-height:24px;text-overflow:ellipsis;white-space:nowrap}",
      ".prcard-accepted-badge{display:inline-flex;flex:none;align-items:center;height:20px;padding:0 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 14%,transparent);color:var(--dsw-alias-state-success-primary,#16a34a);font-size:11px;line-height:20px;white-space:nowrap}",
      ".prcard-copy-error{flex:none;color:var(--dsw-alias-state-error-primary,#d93026);font-size:11px;line-height:16px}",
      ".prcard-copy{display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;outline:none}",
      ".prcard-copy:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#1f2329)}",
      ".prcard-copy:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3,rgba(128,128,128,.38))}",
      ".prcard-copy:disabled{cursor:default;opacity:.7}",
      ".prcard-header-actions{display:flex;flex:none;align-items:center;gap:4px}",
      ".prcard-expand{display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;outline:none}",
      ".prcard-expand:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#1f2329)}",
      ".prcard-expand:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3,rgba(128,128,128,.38))}",
      ".prcard-expand:disabled{cursor:default;opacity:.7}",
      ".prcard-body{overscroll-behavior:contain;flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 16px 4px;font-size:14px;line-height:22px}",
      ".prcard-history .prcard-body{position:relative;overflow:hidden;padding:12px 16px 4px}",
      ".prcard-history .prcard-body::after{content:\"\";position:absolute;left:0;right:0;bottom:0;height:96px;background:linear-gradient(to bottom,transparent 0%,var(--dsw-specific-input-major,#fff) 62%,var(--dsw-specific-input-major,#fff) 100%);pointer-events:none}",
      ".prcard-result{flex:none;padding:8px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:20px;white-space:pre-wrap;word-break:break-word}",
      ".prcard-result[data-error=true]{color:var(--dsw-alias-state-error-primary,#d93026)}",
      ".prcard-expanded-overlay{position:fixed;inset:0;z-index:1200;display:flex;justify-content:center;align-items:center;padding:48px 16px;background:rgba(15,18,22,.55);box-sizing:border-box}",
      ".prcard-expanded-panel,.prcard-expanded-panel *{box-sizing:border-box}",
      ".prcard-expanded-panel{display:flex;flex-direction:column;width:100%;max-width:var(--dsh-chat-content-width,748px);height:100%;max-height:calc(100vh - 96px);overflow:hidden;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(128,128,128,.24));border-radius:16px;background:var(--dsw-specific-input-major,#fff);box-shadow:var(--dsw-shadow-lv3,0 24px 48px rgba(0,0,0,.24));color:var(--dsw-alias-label-primary,#1f2329);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.28));--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2,rgba(128,128,128,.42))}",
      ".prcard-footer{display:flex;flex:none;flex-direction:column;gap:6px;padding:8px 16px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}",
      ".prcard-feedback{min-width:0;color:var(--dsw-alias-state-error-primary,#d93026);font-size:11px;line-height:16px;word-break:break-word}",
      ".prcard-compose{display:flex;align-items:flex-end;gap:8px}",
      ".prcard-input{flex:1 1 auto;min-width:0;min-height:36px;max-height:96px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(128,128,128,.24));border-radius:10px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:20px;resize:none;outline:none;font-family:inherit}",
      ".prcard-input::placeholder{color:var(--dsw-alias-label-caption,#8a8f99)}",
      ".prcard-input:focus{border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.38))}",
      ".prcard-input:disabled{cursor:default;opacity:.7}",
      ".prcard-actions{display:flex;flex:none;align-items:center;justify-content:flex-end;gap:8px}",
      ".prcard-icon-action{display:grid;place-items:center;flex:none;width:28px;height:28px;margin-bottom:4px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;outline:none}",
      ".prcard-icon-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#1f2329)}",
      ".prcard-icon-action:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3,rgba(128,128,128,.38))}",
      ".prcard-icon-action:disabled{cursor:default;opacity:.7}",
      "@media (max-width:720px){.prcard-frame{padding:6px 12px 10px}.prcard-card{border-radius:16px}.prcard-body{padding:10px 12px 4px}.prcard-history .prcard-body{padding:10px 12px 4px}.prcard-footer{padding:8px 12px 10px}.prcard-compose{flex-wrap:wrap}.prcard-input{flex-basis:100%;width:100%}.prcard-actions{margin-left:auto;flex-wrap:wrap}.prcard-expanded-overlay{padding:24px 12px}.prcard-expanded-panel{max-height:calc(100vh - 48px)}}",
      "@media (prefers-reduced-motion:reduce){.prcard-card,.prcard-history,.prcard-handle::before{transition:none}}",
    ];

    // 功能三：回复完成提醒设置（行样式与设置页的 General preference 保持一致）。
    const ALERT_CSS = [
      ".meh-alert-row{box-sizing:border-box;position:relative;display:flex;align-items:center;gap:8px;min-height:74px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".meh-alert-row-text{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px;padding-right:48px}",
      ".meh-alert-row-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}",
      ".meh-alert-row-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;word-break:break-word}",
      ".meh-alert-row-desc-warning{color:var(--dsw-alias-state-warning-primary,#d97706)}",
      ".meh-alert-control{position:relative;display:flex;flex:none;align-items:center;gap:8px}",
      ".meh-alert-switch{appearance:none;position:relative;width:38px;height:22px;flex:none;margin:0;padding:0;border:0;border-radius:11px;background:var(--dsw-alias-fill-l2,rgba(128,128,128,.32));cursor:pointer;outline:none;transition:background-color .16s ease}",
      ".meh-alert-switch::after{content:\"\";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18);transition:transform .16s ease}",
      ".meh-alert-switch[aria-checked=\"true\"]{background:var(--dsw-alias-state-success-primary,#16a34a)}",
      ".meh-alert-switch[aria-checked=\"true\"]::after{transform:translateX(16px)}",
      ".meh-alert-switch:hover{filter:brightness(.96)}",
      ".meh-alert-switch:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3,rgba(128,128,128,.38))}",
      ".meh-alert-switch:disabled{cursor:default;opacity:.45}",
      ".meh-alert-selector{box-sizing:border-box;height:36px;padding:0 14px;border:0;border-radius:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;align-items:center;gap:12px;display:inline-flex}",
      ".meh-alert-selector:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".meh-alert-selector:focus-visible{outline:2px solid var(--dsw-alias-border-l3,rgba(128,128,128,.38));outline-offset:1px}",
      ".meh-alert-chevron{flex:none}",
      ".meh-alert-hint{position:absolute;top:calc(100% + 6px);right:0;z-index:80;width:280px;padding:8px 10px;border-radius:8px;background:var(--dsw-specific-input-major,#fff);border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(128,128,128,.24));box-shadow:var(--dsw-shadow-lv2,0 4px 16px rgba(0,0,0,.12));color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:18px;text-align:left}",
    ];

    // 功能四：气泡编辑重发样式。挂载点 display:contents 不产生盒子，内容
    // （编辑按钮）直接参与 actions 容器的 flex 布局，紧贴复制按钮左侧且不
    // 挤动时间/复制按钮；编辑器替换气泡区（userStack）显示。
    const EDIT_CSS = [
      "[data-meh-edit-mount]{display:contents}",
      "[data-meh-edit-mount] button.meh-bubble-edit{box-sizing:border-box;display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;outline:none;vertical-align:middle}",
      "[data-meh-edit-mount] button.meh-bubble-edit:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#1f2329)}",
      "[data-meh-edit-mount] button.meh-bubble-edit:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3,rgba(128,128,128,.38))}",
      "[data-meh-edit-mount] button.meh-bubble-edit:disabled{cursor:default;opacity:.45}",
      "[data-meh-editor]{display:flex;flex-direction:column;gap:8px;width:100%;box-sizing:border-box}",
      "[data-meh-editor] textarea.meh-edit-input{box-sizing:border-box;width:100%;min-height:76px;max-height:240px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:10px;background:var(--dsw-specific-input-major,#fff);color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:14px;line-height:22px;resize:none;outline:none}",
      "[data-meh-editor] textarea.meh-edit-input:focus{border-color:var(--dsw-alias-brand-primary,#3d6df2);box-shadow:0 0 0 2px rgba(61,109,242,.25)}",
      "[data-meh-editor] .meh-edit-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px}",
      "[data-meh-editor] .meh-edit-cancel{box-sizing:border-box;padding:4px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font:inherit;font-size:13px;line-height:20px;cursor:pointer}",
      "[data-meh-editor] .meh-edit-cancel:hover{border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.4))}",
      "[data-meh-editor] .meh-edit-save{box-sizing:border-box;padding:4px 16px;border:1px solid var(--dsw-alias-brand-primary,#3d6df2);border-radius:8px;background:var(--dsw-alias-brand-primary,#3d6df2);color:#fff;font:inherit;font-size:13px;line-height:20px;cursor:pointer}",
      "[data-meh-editor] .meh-edit-save:disabled{cursor:default;opacity:.5}",
    ];

    // 合并后的单一样式表：索引标尺（meh-*）、计划卡片（prcard-*）、提醒开关
    // （meh-alert-*）与气泡编辑（meh-edit-*）前缀互不冲突。
    const STYLE = [...RULER_CSS, ...REVIEW_CSS, ...ALERT_CSS, ...EDIT_CSS].join("\n");

    function mountStyles() {
      if (typeof document === "undefined") return () => {};
      const stale = document.querySelector(`style[data-plugin-css="${STYLE_TAG}"]`);
      if (stale !== null) stale.remove();

      const tag = document.createElement("style");
      tag.dataset.plugin = "@dsh/message-enhancer";
      tag.dataset.pluginCss = STYLE_TAG;
      tag.textContent = STYLE;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    function planReviewOf(questions) {
      if (questions.length !== 1) return undefined;
      const question = questions[0];
      const intent = question.intent;
      if (intent?.kind !== "plan-review" || question.detail === undefined) return undefined;
      if (question.multiSelect === true) return undefined;

      const options = question.options ?? [];
      if (options.length > 2) return undefined;
      const approve = options.find((option) => option.label === intent.approve);
      if (approve === undefined) return undefined;
      const decline = options.find((option) => option.label !== intent.approve);
      return {
        id: question.id,
        question: question.question,
        plan: question.detail,
        approve,
        decline,
      };
    }

    function selectPlanReview({ interactions }) {
      for (const wait of interactions) {
        if (wait.kind !== "question") continue;
        const review = planReviewOf(wait.payload.questions);
        if (review !== undefined) return { wait, review };
      }
      return null;
    }

    async function answerReview(wait, review, choice) {
      // choice: { label } selects an option; { custom } sends review feedback.
      // The wire contract forbids custom together with a non-empty selection.
      const item = choice.custom === undefined
        ? { id: review.id, selected: [choice.label] }
        : { id: review.id, selected: [], custom: choice.custom };
      const receipt = await wait.respond({
        ok: true,
        value: {
          sessionId: wait.sessionId,
          answer: {
            answers: [item],
          },
        },
      });
      if (!receipt.accepted) throw new Error(`question response rejected: ${receipt.reason}`);
    }

    async function cancelReview(wait) {
      const receipt = await wait.respond({
        ok: false,
        error: {
          code: "cancelled",
          message: "the user closed this question request",
          details: {},
        },
      });
      if (!receipt.accepted) throw new Error(`question cancellation rejected: ${receipt.reason}`);
    }

    function optionTooltip(description) {
      return description === undefined ? {} : { title: description };
    }

    function usePlanCopy(ctx, plan, onFailure) {
      const [copied, setCopied] = React.useState(false);
      const copyTimer = React.useRef(null);

      React.useEffect(() => () => {
        if (copyTimer.current !== null) copyTimer.current();
      }, []);

      const copy = () => {
        if (copied) return;
        primitives.writeClipboard(plan).then((accepted) => {
          if (!accepted) {
            onFailure();
            return;
          }
          setCopied(true);
          if (copyTimer.current !== null) copyTimer.current();
          copyTimer.current = ctx.timeout(() => {
            copyTimer.current = null;
            setCopied(false);
          }, 1000);
        }).catch(onFailure);
      };

      return { copied, copy };
    }

    function createPlanReviewCard(ctx) {
      function PlanReviewCard({ wait, review, t }) {
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(null);
        // 初始默认展开以便直接阅读计划全文，用户可点顶部手柄收起。
        const [expanded, setExpanded] = React.useState(true);
        const [feedback, setFeedback] = React.useState("");
        const cardRef = React.useRef(null);
        const viewportFit = primitives.useAnchoredMaxHeight(cardRef, 10000, expanded);
        // 测量未就绪时 hook 可能返回传入的上限值（10000）或 0。此时绝不能
        // 把卡片撑到近万像素（挂载瞬间整屏白色巨卡），先不设置 inline 高度，
        // 由 CSS 的 max-height:min(60vh,520px) 兜底，测量完成后再展开。
        const measured = viewportFit > 0 && viewportFit < 10000;
        const expandedHeight = Math.max(240, viewportFit - EXPANDED_TOP_RESERVE);
        // 正文延迟一帧渲染：MarkdownText 渲染长计划若耗时，卡片壳
        // （手柄/标题/按钮）先出现，避免 React 同步渲染把整卡卡成白屏。
        const [bodyReady, setBodyReady] = React.useState(false);
        React.useEffect(() => {
          if (bodyReady) return undefined;
          const frame = requestAnimationFrame(() => setBodyReady(true));
          return () => cancelAnimationFrame(frame);
        }, [bodyReady]);
        const copyState = usePlanCopy(ctx, review.plan, () => setError(t("copyFailed")));

        const settle = (send) => {
          setBusy(true);
          setError(null);
          send().catch((cause) => {
            setBusy(false);
            setError(cause instanceof Error ? cause.message : String(cause));
          });
        };

        const decide = (label) => {
          settle(() => answerReview(wait, review, { label }));
        };

        const decline = review.decline;
        const trimmedFeedback = feedback.trim();
        const submitDecline = () => {
          if (decline === undefined) return;
          // 空反馈拒绝发送宿主原生 decline 选项，插件不注入额外内容——
          // 协议行为与 DSH 原生界面完全一致（拒绝即 keep planning，
          // 模型继续规划并重新提交计划）。
          const choice = trimmedFeedback === ""
            ? { label: decline.label }
            : { custom: trimmedFeedback };
          settle(() => answerReview(wait, review, choice));
        };

        const resizeFeedback = (element) => {
          element.style.height = "36px";
          const height = Math.min(96, Math.max(36, element.scrollHeight));
          element.style.height = `${height}px`;
          element.style.overflowY = element.scrollHeight > 96 ? "auto" : "hidden";
        };

        const changeFeedback = (event) => {
          setFeedback(event.target.value);
          resizeFeedback(event.currentTarget);
        };

        const submitFeedbackFromKeyboard = (event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent?.isComposing) return;
          event.preventDefault();
          submitDecline();
        };

        const copyPlan = () => {
          setError(null);
          copyState.copy();
        };

        const expandLabel = t(expanded ? "collapse" : "expand");
        const copyLabel = t(copyState.copied ? "copied" : "copy");

        return React.createElement("div", {
          className: "prcard-frame",
          "data-plan-review-card": wait.key,
        }, React.createElement("section", {
          ref: cardRef,
          className: "prcard-card",
          style: expanded && measured ? {
            height: `${expandedHeight}px`,
            maxHeight: `${expandedHeight}px`,
          } : undefined,
          "aria-label": review.question,
        },
        React.createElement("div", { className: "prcard-handle-row" },
          React.createElement(primitives.Tooltip, {
            label: expandLabel,
            side: "top",
          }, React.createElement("button", {
            type: "button",
            className: "prcard-handle",
            "aria-label": expandLabel,
            "aria-expanded": expanded,
            disabled: busy,
            onClick: () => setExpanded((current) => !current),
          })),
        ),
        React.createElement("header", { className: "prcard-header" },
          React.createElement("span", { className: "prcard-title" }, t("header")),
          React.createElement(primitives.Tooltip, {
            label: copyLabel,
            side: "bottom",
          }, React.createElement("button", {
            type: "button",
            className: "prcard-copy",
            "aria-label": copyLabel,
            disabled: copyState.copied,
            onClick: copyPlan,
          }, copyState.copied
            ? React.createElement(primitives.IconCheckOutline16)
            : React.createElement(primitives.IconCopyOutline16))),
        ),
        React.createElement("div", {
          className: "prcard-body",
          "data-plan-review-scroll": true,
        }, bodyReady ? React.createElement(primitives.MarkdownText, { text: review.plan }) : null),
        React.createElement("footer", { className: "prcard-footer" },
          error === null ? null : React.createElement("div", {
            className: "prcard-feedback",
            role: "status",
          }, error),
          React.createElement("div", { className: "prcard-compose" },
            decline === undefined ? null : React.createElement("textarea", {
              className: "prcard-input",
              value: feedback,
              rows: 1,
              disabled: busy,
              placeholder: t("feedbackPlaceholder"),
              "aria-label": t("feedbackPlaceholder"),
              onChange: changeFeedback,
              onKeyDown: submitFeedbackFromKeyboard,
            }),
            React.createElement("div", { className: "prcard-actions" },
              React.createElement(primitives.Tooltip, {
                label: t("discuss"),
                side: "top",
              }, React.createElement("button", {
                type: "button",
                className: "prcard-icon-action",
                "aria-label": t("discuss"),
                disabled: busy,
                onClick: () => settle(() => cancelReview(wait)),
              }, React.createElement(primitives.IconEditOutline16, { size: 14 }))),
              decline === undefined ? null : React.createElement(primitives.Button, {
                variant: "outline",
                ...optionTooltip(decline.description),
                disabled: busy,
                onClick: submitDecline,
              }, t(trimmedFeedback === "" ? "decline" : "submitFeedback")),
              React.createElement(primitives.Button, {
                variant: "primary",
                ...optionTooltip(review.approve.description),
                disabled: busy,
                onClick: () => decide(review.approve.label),
              }, t("approve")),
            ),
          ),
        )));
      }

      return function PlanReviewEntry({ matched, t }) {
        return React.createElement(PlanReviewCard, {
          key: matched.wait.key,
          wait: matched.wait,
          review: matched.review,
          t,
        });
      };
    }

    function planFromSettledBlock(block) {
      if (!("kind" in block)) return undefined;
      // 复用共享解析：非法/缺失计划返回 null，与原实现保持一致。
      return parsePlanArgsRaw(block.call?.argsRaw);
    }

    function resultTextFromSettledBlock(block) {
      if (!Array.isArray(block.content)) return null;
      const text = block.content.map((content) => {
        if (content?.type === "text" && typeof content.text === "string") return content.text;
        try {
          return JSON.stringify(content, null, 2);
        } catch {
          return "";
        }
      }).join("").trim();
      return text === "" ? null : text;
    }

    function createPlanHistoryToolView(ctx) {
      function PlanHistoryCard({ callId, plan, result, isError, accepted, t }) {
        const displayResult = result ?? t(isError ? "resultRejected" : "resultApproved");
        const [focus, setFocus] = React.useState(false);
        const [copyError, setCopyError] = React.useState(null);
        const panelRef = React.useRef(null);
        const copyState = usePlanCopy(ctx, plan, () => setCopyError(t("copyFailed")));
        const copyLabel = t(copyState.copied ? "copied" : "copy");
        const focusLabel = t(focus ? "collapseWindow" : "expandWindow");
        const acceptedBadge = accepted
          ? React.createElement("span", { className: "prcard-accepted-badge" }, t("acceptedPlan"))
          : null;

        const copyPlan = () => {
          setCopyError(null);
          copyState.copy();
        };

        // 浮层焦点管理：打开时把焦点移入面板，Tab 循环限制在面板内，
        // Esc/遮罩/关闭按钮收起后把焦点还给打开前的元素（通常是触发按钮）。
        React.useEffect(() => {
          if (typeof window === "undefined" || typeof document === "undefined" || !focus) return undefined;
          const panel = panelRef.current;
          const previous = document.activeElement;
          if (panel !== null && typeof panel.focus === "function") panel.focus();
          const onKeyDown = (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setFocus(false);
              return;
            }
            if (event.key !== "Tab" || panel === null) return;
            const focusable = panel.querySelectorAll('button,[href],textarea,input,select,[tabindex]:not([tabindex="-1"])');
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (event.shiftKey && (active === first || active === panel)) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && (active === last || active === panel || active === document.body)) {
              event.preventDefault();
              first.focus();
            }
          };
          window.addEventListener("keydown", onKeyDown);
          return () => {
            window.removeEventListener("keydown", onKeyDown);
            if (previous && typeof previous.focus === "function") previous.focus();
          };
        }, [focus]);

        const panel = React.createElement("section", {
          ref: panelRef,
          className: "prcard-expanded-panel",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": t("historyHeader"),
          tabIndex: -1,
          onClick: (event) => event.stopPropagation(),
        },
        React.createElement("header", { className: "prcard-header" },
          React.createElement("span", { className: "prcard-title" }, t("historyHeader")),
          acceptedBadge,
          React.createElement("div", { className: "prcard-header-actions" },
            React.createElement(primitives.Tooltip, {
              label: copyLabel,
              side: "bottom",
            }, React.createElement("button", {
              type: "button",
              className: "prcard-copy",
              "aria-label": copyLabel,
              disabled: copyState.copied,
              onClick: copyPlan,
            }, copyState.copied
              ? React.createElement(primitives.IconCheckOutline16)
              : React.createElement(primitives.IconCopyOutline16))),
            React.createElement(primitives.Tooltip, {
              label: focusLabel,
              side: "bottom",
            }, React.createElement("button", {
              type: "button",
              className: "prcard-expand",
              "aria-label": focusLabel,
              onClick: () => setFocus(false),
            }, React.createElement(primitives.IconCloseOutline16))),
          ),
        ),
        React.createElement("div", {
          className: "prcard-body",
          "data-plan-history-scroll": true,
        }, React.createElement(primitives.MarkdownText, { text: plan })),
        React.createElement("div", {
          className: "prcard-result",
          "data-error": isError ? "true" : "false",
          role: "status",
        }, displayResult));

        const overlay = React.createElement("div", {
          className: "prcard-expanded-overlay",
          onClick: () => setFocus(false),
        }, panel);

        return React.createElement("div", null,
        React.createElement("section", {
          className: "prcard-history",
          "data-plan-history-card": callId,
          "aria-label": t("historyHeader"),
        },
        React.createElement("header", { className: "prcard-header" },
          React.createElement("span", { className: "prcard-title" }, t("historyHeader")),
          acceptedBadge,
          copyError === null ? null : React.createElement("span", {
            className: "prcard-copy-error",
            role: "status",
          }, copyError),
          React.createElement("div", { className: "prcard-header-actions" },
            React.createElement(primitives.Tooltip, {
              label: copyLabel,
              side: "bottom",
            }, React.createElement("button", {
              type: "button",
              className: "prcard-copy",
              "aria-label": copyLabel,
              disabled: copyState.copied,
              onClick: copyPlan,
            }, copyState.copied
              ? React.createElement(primitives.IconCheckOutline16)
              : React.createElement(primitives.IconCopyOutline16))),
            React.createElement(primitives.Tooltip, {
              label: focusLabel,
              side: "bottom",
            }, React.createElement("button", {
              type: "button",
              className: "prcard-expand",
              "aria-label": focusLabel,
              onClick: () => setFocus(true),
            }, React.createElement(primitives.IconFullscreenOutline16))),
          ),
        ),
        React.createElement("div", {
          className: "prcard-body",
          "data-plan-history-scroll": true,
        }, React.createElement(primitives.MarkdownText, { text: plan })),
        React.createElement("div", {
          className: "prcard-result",
          "data-error": isError ? "true" : "false",
          role: "status",
        }, displayResult)),
        focus && ReactDOM !== null && typeof document !== "undefined"
          ? ReactDOM.createPortal(overlay, document.body)
          : null);
      }

      return function PlanHistoryToolView({ block, t, useSession, useProjection }) {
        const plan = planFromSettledBlock(block);
        const latestPlanCallId = useSession === undefined ? null : useSession((snapshot) => {
          let latest = null;
          for (const node of snapshot?.nodes ?? []) {
            if (node?.kind !== "tool-result") continue;
            if (node.call?.name !== "exit_plan_mode") continue;
            latest = node.callId;
          }
          return latest;
        });
        const projection = useProjection === undefined ? undefined : useProjection("plan");
        const accepted = plan !== null && plan !== undefined
          && projection !== undefined && projection.active === false
          && latestPlanCallId === block.callId;
        if (plan === undefined) {
          // block 尚未 settle（模型仍在流式生成计划文本，通常持续十几秒以上）。
          // 本插件已按 key 接管 exit_plan_mode 的展示，此处必须渲染占位，
          // 否则流式期间聊天流中该工具调用区域会显示为一片空白。
          return React.createElement("div", {
            className: "prcard-history-unavailable",
            "data-plan-generating": true,
            role: "status",
          }, t("generating"));
        }
        if (plan === null) {
          return React.createElement("div", {
            className: "prcard-history-unavailable",
            role: "status",
          }, t("historyUnavailable"));
        }
        return React.createElement(PlanHistoryCard, {
          key: block.callId,
          callId: block.callId,
          plan,
          result: resultTextFromSettledBlock(block),
          isError: block.isError === true,
          accepted,
          t,
        });
      };
    }

    // ============================================================
    // 功能三：回复完成提醒（提示音 + Windows 系统通知）
    //
    // 时机：会话快照的 turnEnds 出现更大的回合号，且该回合的 turn/end
    // reason 为正常完成（completed / max-tokens）。用户停止（aborted /
    // interrupted）、报错（error）与计划被退回（blocked）不提醒。
    // 挂载时把当前最大回合号记为基线，打开旧会话 / 加载更早历史不误响。
    // ============================================================

    const ALERT_SOUND_KEY = "@dsh/message-enhancer/alert-sound";
    const ALERT_TONE_KEY = "@dsh/message-enhancer/alert-tone";
    const ALERT_NOTIFY_KEY = "@dsh/message-enhancer/alert-notify";
    const ALERT_TONE_VALUES = ["chime", "marimba", "soft"];

    // 开关状态持久化；读写均容错，损坏时回退默认值（音效开、通知关）。
    function readAlertFlag(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === "1") return true;
        if (raw === "0") return false;
        return fallback;
      } catch {
        return fallback;
      }
    }
    function writeAlertFlag(key, value) {
      try {
        window.localStorage.setItem(key, value ? "1" : "0");
      } catch {}
    }

    function readAlertTone() {
      try {
        const raw = window.localStorage.getItem(ALERT_TONE_KEY);
        return ALERT_TONE_VALUES.includes(raw) ? raw : "chime";
      } catch {
        return "chime";
      }
    }

    function writeAlertTone(tone) {
      const value = ALERT_TONE_VALUES.includes(tone) ? tone : "chime";
      try {
        window.localStorage.setItem(ALERT_TONE_KEY, value);
      } catch {}
      return value;
    }

    // —— 提示音：Web Audio 合成多种短音，无音频文件依赖 ——
    // 浏览器自动播放策略：AudioContext 需用户手势后才能出声。首次用户交互
    // （pointerdown/keydown）时创建并 resume；播放前若仍 suspended 再尝试
    // resume，任何失败都静默，绝不打断聊天。
    let alertAudioContext = null;
    let audioWakeBound = false;

    function wakeAlertAudio() {
      if (typeof window === "undefined") return null;
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (typeof AudioContextCtor !== "function") return null;
      try {
        if (alertAudioContext === null) alertAudioContext = new AudioContextCtor();
        if (alertAudioContext.state === "suspended") alertAudioContext.resume().catch(() => {});
        return alertAudioContext;
      } catch {
        return null;
      }
    }

    function bindAudioWake() {
      if (audioWakeBound || typeof document === "undefined") return () => {};
      audioWakeBound = true;
      const onPointer = () => wakeAlertAudio();
      const onKey = () => wakeAlertAudio();
      document.addEventListener("pointerdown", onPointer, { capture: true, once: true });
      document.addEventListener("keydown", onKey, { capture: true, once: true });
      return () => {
        document.removeEventListener("pointerdown", onPointer, true);
        document.removeEventListener("keydown", onKey, true);
        audioWakeBound = false;
      };
    }

    function toneNotes(tone) {
      if (tone === "marimba") {
        return [
          [523.25, 0, 0.16, 0.18, "triangle"],
          [659.25, 0.12, 0.18, 0.16, "triangle"],
          [783.99, 0.24, 0.24, 0.14, "triangle"],
        ];
      }
      if (tone === "soft") {
        return [[698.46, 0, 0.38, 0.13, "sine"]];
      }
      return [
        [1046.5, 0, 0.12, 0.18, "sine"],
        [1318.5, 0.16, 0.2, 0.22, "sine"],
      ];
    }

    function playAlertTone(tone) {
      const ctx = wakeAlertAudio();
      if (ctx === null) return;
      const finish = () => {
        if (ctx.state !== "running") return;
        try {
          const now = ctx.currentTime;
          toneNotes(tone).forEach(([freq, start, dur, vol, type]) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, now + start);
            gain.gain.exponentialRampToValueAtTime(vol, now + start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now + start);
            osc.stop(now + start + dur + 0.02);
          });
        } catch {}
      };
      if (ctx.state === "running") {
        finish();
      } else if (ctx.state === "suspended") {
        ctx.resume().then(finish).catch(() => {});
      }
    }

    // —— 回合完成检测 ——
    // reason.kind：completed / max-tokens 为正常完成；其余（aborted /
    // error / blocked / interrupted 等）不提醒，避免用户停止或报错时误响。
    function completionReasonOf(session, turn) {
      if (!session || !session.chat || !session.chat.timeline || typeof session.chat.timeline.turns.get !== "function") return null;
      const located = session.chat.timeline.turns.get(turn);
      const kind = located?.end?.data?.reason?.kind;
      return kind === "completed" || kind === "max-tokens" ? kind : null;
    }

    // 快照中最大的已完成回合号；无 turnEnds 时返回 null。
    function largestTurnEnd(session) {
      const turnEnds = session?.turnEnds;
      if (!turnEnds || typeof turnEnds.keys !== "function") return null;
      let largest = -1;
      for (const turn of turnEnds.keys()) {
        if (turn > largest) largest = turn;
      }
      return largest < 0 ? null : largest;
    }

    // —— Windows 系统通知（Notification API；localhost 属 secure context 可用）——
    function notifyCompletion(sessionId) {
      if (typeof Notification === "undefined") return;
      if (Notification.permission !== "granted") return;
      try {
        // silent: true —— 声音交给 Web Audio 提示音统一控制，避免双响。
        new Notification("DSH 回复完成", {
          body: "模型已生成回复，点击返回会话。",
          tag: "dsh-reply-" + sessionId,
          silent: true,
        });
      } catch {}
    }

    const ALERT_NS = "message-enhancer-alert";
    const ALERT_ZH = {
      soundTitle: "回复完成提示音",
      soundDescription: "模型完成一轮回复时播放提示音。",
      soundOn: "已开启",
      soundOff: "已关闭",
      toneTitle: "提示音类型",
      toneDescription: "选择后会立即试听，正式提醒也会使用该音效。",
      toneChime: "经典叮咚",
      toneMarimba: "轻快三音",
      toneSoft: "柔和单音",
      notifyTitle: "Windows 系统通知",
      notifyDescription: "模型完成一轮回复时显示系统通知。",
      notifyDeniedDescription: "通知权限已被拒绝，点击右侧开关查看恢复步骤。",
      notifyUnsupportedDescription: "当前页面不支持系统通知，请使用 localhost 或 HTTPS。",
      notifyOn: "已开启",
      notifyOff: "已关闭",
      notifyDeniedHint: "通知权限已被浏览器拒绝。点击地址栏左侧的锁/信息图标 → 网站设置 → 通知 → 改为“允许”，然后刷新页面。",
      notifyUnsupportedHint: "当前页面不是 localhost / HTTPS，浏览器禁用了系统通知。请使用 http://127.0.0.1:3080 或 HTTPS 打开。",
    };
    const ALERT_EN = {
      soundTitle: "Reply completion sound",
      soundDescription: "Play a sound when the model finishes a reply.",
      soundOn: "On",
      soundOff: "Off",
      toneTitle: "Sound type",
      toneDescription: "Selecting a sound previews it immediately and uses it for future alerts.",
      toneChime: "Classic chime",
      toneMarimba: "Quick three-note",
      toneSoft: "Soft single tone",
      notifyTitle: "Windows system notification",
      notifyDescription: "Show a system notification when the model finishes a reply.",
      notifyDeniedDescription: "Notification permission was denied. Click the switch for recovery steps.",
      notifyUnsupportedDescription: "System notifications require localhost or HTTPS.",
      notifyOn: "On",
      notifyOff: "Off",
      notifyDeniedHint: "Browser notification permission was denied. Open the lock/info icon → Site settings → Notifications → Allow, then refresh the page.",
      notifyUnsupportedHint: "This page is not using localhost or HTTPS. Open http://127.0.0.1:3080 or an HTTPS URL.",
    };

    function alertText(t, key) {
      return typeof t === "function" ? t(key) : key;
    }

    function AlertSettingRow({ title, description, warning, children }) {
      return React.createElement("div", { className: "meh-alert-row" },
        React.createElement("div", { className: "meh-alert-row-text" },
          React.createElement("div", { className: "meh-alert-row-title" }, title),
          React.createElement("div", {
            className: "meh-alert-row-desc" + (warning ? " meh-alert-row-desc-warning" : ""),
          }, description)),
        children);
    }

    function AlertSwitch({ checked, label, onClick }) {
      return React.createElement("button", {
        type: "button",
        className: "meh-alert-switch",
        role: "switch",
        "aria-checked": checked,
        "aria-label": label,
        onClick,
      });
    }

    function AlertSoundSettingRow({ t }) {
      const [soundOn, setSoundOn] = React.useState(() => readAlertFlag(ALERT_SOUND_KEY, true));
      const translate = (key) => alertText(t, key);
      const toggle = () => {
        const next = !soundOn;
        setSoundOn(next);
        writeAlertFlag(ALERT_SOUND_KEY, next);
      };
      const label = soundOn ? translate("soundOn") : translate("soundOff");
      return React.createElement(AlertSettingRow, {
        title: translate("soundTitle"),
        description: translate("soundDescription"),
      }, React.createElement("div", { className: "meh-alert-control" },
        React.createElement(AlertSwitch, {
          checked: soundOn,
          label: translate("soundTitle") + " · " + label,
          onClick: toggle,
        })));
    }

    function AlertToneSettingRow({ t }) {
      const [tone, setTone] = React.useState(() => readAlertTone());
      const [open, setOpen] = React.useState(false);
      const translate = (key) => alertText(t, key);
      const options = [
        { id: "chime", label: translate("toneChime") },
        { id: "marimba", label: translate("toneMarimba") },
        { id: "soft", label: translate("toneSoft") },
      ];
      const selected = options.find((option) => option.id === tone) ?? options[0];
      const chooseTone = (id) => {
        setOpen(false);
        const next = writeAlertTone(id);
        setTone(next);
        // 选择时试听，点击行为本身满足浏览器音频用户手势要求。
        playAlertTone(next);
      };
      return React.createElement(AlertSettingRow, {
        title: translate("toneTitle"),
        description: translate("toneDescription"),
      }, React.createElement(primitives.Menu, {
        open,
        onClose: () => setOpen(false),
        items: options,
        selectedId: tone,
        onSelect: chooseTone,
        align: "end",
        portal: true,
        anchor: React.createElement("button", {
          type: "button",
          className: "meh-alert-selector",
          "aria-haspopup": "menu",
          "aria-expanded": open,
          onClick: () => setOpen((value) => !value),
        }, selected.label, React.createElement(primitives.IconChevronDownOutline14, {
          className: "meh-alert-chevron",
        })),
      }));
    }

    function currentNotificationPermission() {
      if (typeof Notification === "undefined" || !Notification.permission) return "unsupported";
      return Notification.permission;
    }

    function AlertNotifySettingRow({ t }) {
      const [notifyOn, setNotifyOn] = React.useState(() => readAlertFlag(ALERT_NOTIFY_KEY, false));
      const [permission, setPermission] = React.useState(() => currentNotificationPermission());
      const [hintOpen, setHintOpen] = React.useState(false);
      const translate = (key) => alertText(t, key);
      const unavailable = permission === "denied" || permission === "unsupported";
      const descriptionKey = permission === "denied"
        ? "notifyDeniedDescription"
        : permission === "unsupported"
          ? "notifyUnsupportedDescription"
          : "notifyDescription";
      const hintText = permission === "denied"
        ? translate("notifyDeniedHint")
        : permission === "unsupported"
          ? translate("notifyUnsupportedHint")
          : null;

      const toggle = () => {
        if (unavailable) {
          setHintOpen((current) => !current);
          return;
        }
        if (permission === "default") {
          Notification.requestPermission().then((nextPermission) => {
            setPermission(nextPermission);
            if (nextPermission === "granted") {
              setNotifyOn(true);
              writeAlertFlag(ALERT_NOTIFY_KEY, true);
              setHintOpen(false);
            } else if (nextPermission === "denied") {
              setHintOpen(true);
            }
          }).catch(() => {
            setPermission("denied");
            setHintOpen(true);
          });
          return;
        }
        const next = !notifyOn;
        setNotifyOn(next);
        writeAlertFlag(ALERT_NOTIFY_KEY, next);
      };

      const checked = permission === "granted" && notifyOn;
      const label = checked ? translate("notifyOn") : translate("notifyOff");
      return React.createElement(AlertSettingRow, {
        title: translate("notifyTitle"),
        description: translate(descriptionKey),
        warning: unavailable,
      }, React.createElement("div", { className: "meh-alert-control" },
        React.createElement(AlertSwitch, {
          checked,
          label: translate("notifyTitle") + " · " + label,
          onClick: toggle,
        }),
        hintOpen && hintText !== null ? React.createElement("div", {
          className: "meh-alert-hint",
          role: "status",
        }, hintText) : null));
    }

    // 会话侧只负责观察回合结束，设置页修改的值在触发瞬间从 localStorage 读取，
    // 因而不依赖 root 设置槽位与 session 槽位之间的 React 状态同步。
    function useTurnEndAlert(session) {
      const baseRef = React.useRef(null);
      const sessionIdRef = React.useRef(null);
      React.useEffect(() => bindAudioWake(), []);
      React.useEffect(() => {
        const sessionId = session?.sessionId;
        if (sessionIdRef.current !== sessionId) {
          sessionIdRef.current = sessionId;
          baseRef.current = null;
        }
        const largest = largestTurnEnd(session);
        if (baseRef.current === null) {
          // 新会话或正在运行的首轮没有 turnEnds 时，-1 才能让首轮完成触发提醒；
          // 老会话加载阶段则等待已有 turnEnds，避免载入历史时误响。
          if (largest === null) {
            if (session?.blank === true || session?.running === true) baseRef.current = -1;
            return;
          }
          baseRef.current = largest;
          return;
        }
        if (largest === null || largest <= baseRef.current) return;
        const soundOn = readAlertFlag(ALERT_SOUND_KEY, true);
        const notifyOn = readAlertFlag(ALERT_NOTIFY_KEY, false);
        const tone = readAlertTone();
        for (let turn = baseRef.current + 1; turn <= largest; turn += 1) {
          if (completionReasonOf(session, turn) === null) continue;
          if (soundOn) playAlertTone(tone);
          if (notifyOn) notifyCompletion(session.sessionId);
        }
        baseRef.current = largest;
      }, [session]);
    }

    function TurnAlertWatch({ session }) {
      useTurnEndAlert(session);
      return null;
    }

    // ============================================================
    // 功能四：最后一条用户消息「气泡编辑重发」（fork 分支重新生成）
    //
    // 在最后一条 kind==="user" 消息气泡的操作行（复制按钮左侧）注入一个
    // 编辑按钮。用户气泡 UserStyleBubble 没有原生 action slot，故采用 DOM
    // 注入：MutationObserver + rAF 防抖的 fit 循环幂等重注入（与
    // dsh-file-search 装饰气泡同一模式）。点击后气泡区（userStack）原位
    // 变成输入框（ReactDOM 自建 root 渲染 InlineEditor）。
    //
    // 保存语义（DSH 会话日志 append-only + 深冻结，无原地编辑 API）：
    // 1. fork：api.sessions.fork 到最后一条 user 消息之前的 completed turn
    //    边界（atSeq 取该消息之前最近的 assistant 尾节点 seq，与 DSH branch
    //    按钮 forkAt(closing.finalNode.seq) 同一语义）——子会话不含旧消息与
    //    旧回复；
    // 2. 切换：sessions.open(childId) 切到子会话；
    // 3. 发送：api.sessions.prompt 以 queue 模式发送编辑文本，模型重新回答；
    // 4. 归档：api.workspace.archiveSession 归档原会话（观感等同删除、可
    //    恢复）。任一环节失败均保留原会话，不造成数据丢失。
    //
    // 其他设计取舍：
    // - 只回填 text 块，图片不回带（图片依赖 attachment registry 生命周期，
    //   重填需重新注册 imageId，复杂度高且易失效）；
    // - 编辑按钮与编辑器都是 React 自建 root（复用 primitives 图标/Tooltip，
    //   与原生观感一致）；React 重渲染可能冲掉注入节点，fit 循环负责重建，
    //   编辑中的输入内容实时同步到 editingState，重建不丢字；
    // - 模型回复中（session.running）禁用编辑按钮；api.sessions.prompt 缺失
    //   （旧版宿主）同样禁用并提示。
    // ============================================================

    const EDIT_NS = "message-enhancer-edit";

    const EDIT_ZH = {
      edit: "编辑重发",
      editDisabled: "正在回复中，请稍候",
      unsupported: "当前客户端版本不支持此操作",
      save: "发送",
      cancel: "取消",
    };

    const EDIT_EN = {
      edit: "Edit & resend",
      editDisabled: "Replying — try again later",
      unsupported: "Unsupported in this client version",
      save: "Send",
      cancel: "Cancel",
    };

    // 从聊天快照末尾向前找最后一条 kind==="user" 消息的 key、事件 seq 与
    // 纯文本（仅 text 块，多行按 "\n" 拼接）。无 user 节点或文本为空时返回 null。
    function lastUserEntry(chat) {
      if (!chat || !Array.isArray(chat.order) || !chat.nodes || typeof chat.nodes.get !== "function") return null;
      for (let index = chat.order.length - 1; index >= 0; index -= 1) {
        const key = chat.order[index];
        const node = chat.nodes.get(key);
        if (!node || node.kind !== "user" || !node.data || !Array.isArray(node.data.content)) continue;
        const text = node.data.content
          .filter((block) => block && block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("\n");
        if (text.trim() !== "") return { key, text, seq: node.data.seq };
      }
      return null;
    }

    // fork 边界：最后一条 user 消息 seq 之前、seq 最大的已完成 turn 的
    // turn/end 事件 seq。宿主 chat 节点图中每个已完成 turn 对应一个
    // kind === "turn-tail" 节点，其 data.seq 即该轮 turn/end 事件的 seq
    // （assistant 节点的 kind 是 "assistant-step"，不存在 "assistant"）。
    // 宿主 fork 会把 atSeq 锚点推进到「第一个 seq >= atSeq 的 turn/end」，
    // 因此传该值即精确切割：子会话保留该轮及之前全部历史，切掉要编辑的
    // user 消息与旧回复。无则返回 null（单轮会话无历史 turn）。
    function forkBoundarySeq(chat, userSeq) {
      if (!chat || !chat.nodes || typeof chat.nodes.values !== "function" || !Number.isInteger(userSeq)) return null;
      let boundary = null;
      for (const node of chat.nodes.values()) {
        if (!node || node.kind !== "turn-tail") continue;
        const seq = node.data?.seq;
        if (!Number.isInteger(seq) || seq >= userSeq) continue;
        if (boundary === null || seq > boundary) boundary = seq;
      }
      return boundary;
    }

    // —— 模块级共享状态：EditController（React 会话作用域槽）把会话数据写进
    //    liveEdit，fit 循环（MutationObserver）读取它做 DOM 注入；编辑中的
    //    输入内容暂存 editingState，供 React 重渲染后重建编辑器时恢复。 ——
    let liveEdit = {
      sessionId: null,
      lastKey: null,
      lastText: null,
      lastSeq: null, // 最后一条 user 消息的事件 seq（fork 边界计算用）
      boundarySeq: null, // 最后一条 user 消息之前最近的 completed turn 边界 seq
      running: false,
      supported: false,
      permissionPreset: null, // 当前会话权限预设名（"custom" 表示自定义，无法同步）
    };
    let editT = (key) => key;
    let connectionApi = null;
    let sessionsService = null;
    let workspacesService = null; // 归档原会话用（archiveSession）
    let scheduleFit = null; // apply() 里赋值的 rAF 防抖调度器
    // 编辑器运行时状态
    let editingState = null; // { key, text }
    let editorRoot = null;
    let editorHost = null;
    let editorStack = null; // 被隐藏的 userStack 元素
    // 编辑按钮挂载点与 root
    let editMount = null;
    let editMountRoot = null;

    /** CSS 属性选择器转义（anchor key 可能含引号）。 */
    function anchorSelector(key) {
      return '[data-chat-anchor-key="' + String(key).replace(/["\\]/g, "\\$&") + '"]';
    }

    /** 找到复制按钮：优先在 actions 容器（userRow 最后一个子元素）内找，
     *  找不到再全行找。排除编辑按钮自身（.meh-bubble-edit），用户行除复制
     *  按钮外没有其他原生 button。 */
    function findCopyButton(userRow) {
      const actions = userRow.lastElementChild;
      const inActions = actions !== null && typeof actions.querySelector === "function"
        ? actions.querySelector("button[type='button']:not(.meh-bubble-edit)")
        : null;
      if (inActions !== null) return inActions;
      return userRow.querySelector("button[type='button']:not(.meh-bubble-edit)");
    }

    /** 移除当前编辑按钮挂载点（含 React root 卸载）。 */
    function removeEditMount() {
      if (editMountRoot !== null) {
        try { editMountRoot.unmount(); } catch {}
        editMountRoot = null;
      }
      if (editMount !== null) {
        editMount.remove();
        editMount = null;
      }
    }

    let lastRenderedRunning = null; // 上次渲染的 running 值，避免高频 fit 反复 render

    /** 在复制按钮左侧注入编辑按钮。挂载点用 display:contents —— 不产生盒子，
     *  内容直接参与 actions 容器的布局，不会挤动时间/复制按钮（此前直接插
     *  普通 div 会破坏 flex 布局造成重影）。已就位时只纠正位置、按需刷新，
     *  避免 React 重渲染后反复 remove/重建导致的闪烁。 */
    function injectEditButton(row) {
      const copyButton = findCopyButton(row);
      if (copyButton === null) return;
      const parent = copyButton.parentElement;
      if (editMount !== null && editMount.isConnected && editMount.parentElement === parent) {
        if (editMount.nextElementSibling !== copyButton) parent.insertBefore(editMount, copyButton);
        if (lastRenderedRunning !== liveEdit.running) {
          editMountRoot.render(React.createElement(EditButton, { running: liveEdit.running }));
          lastRenderedRunning = liveEdit.running;
        }
        return;
      }
      removeEditMount();
      const mount = document.createElement("div");
      mount.dataset.mehEditMount = "";
      parent.insertBefore(mount, copyButton);
      editMount = mount;
      editMountRoot = ReactDOM.createRoot(mount);
      try {
        editMountRoot.render(React.createElement(EditButton, { running: liveEdit.running }));
        lastRenderedRunning = liveEdit.running;
      } catch (error) {
        // 渲染失败（极端环境）：卸载并清理，避免污染 DSH 布局。
        console.warn("message-enhancer: edit button render failed", error);
        removeEditMount();
      }
    }

    /** 编辑按钮：复制按钮左侧的铅笔按钮（React 自建 root 渲染）。
     *  刻意不用 primitives.Tooltip：自建 root 没有 DSH 的上下文（theme/portal
     *  provider），Tooltip 渲染不可靠，改用原生 title 做提示。 */
    // 空心线条铅笔（Lucide pencil 风格，两段 path：笔形轮廓 + 笔身分割线），
    // stroke 线条与 DSH outline 图标体系一致。
    const EDIT_ICON_PATHS = [
      "M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z",
      "m15 5 4 4",
    ];
    function EditButton({ running }) {
      const disabled = running || !liveEdit.supported;
      const label = !liveEdit.supported ? editT("unsupported") : running ? editT("editDisabled") : editT("edit");
      const onClick = (event) => {
        if (disabled || liveEdit.lastText === null) return;
        const row = event.currentTarget.closest("[data-chat-anchor-key]");
        if (row === null) return;
        startEditing(row, liveEdit.lastText);
      };
      return React.createElement("button", {
        type: "button",
        className: "meh-bubble-edit",
        title: label,
        "aria-label": label,
        disabled,
        onClick,
      }, React.createElement("svg", {
        viewBox: "0 0 24 24",
        width: 15,
        height: 15,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.5,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
      }, EDIT_ICON_PATHS.map((d) => React.createElement("path", { key: d, d }))));
    }

    /** 把编辑器挂到目标行（开始编辑与 React 重渲染后重建共用）。 */
    function mountEditor(row, text) {
      const userRow = row.querySelector("[data-time-hover-root]");
      if (userRow === null) return;
      const userStack = userRow.firstElementChild;
      if (userStack === null) return;
      if (editorRoot !== null) {
        try { editorRoot.unmount(); } catch {}
        editorRoot = null;
      }
      if (editorHost !== null) editorHost.remove();
      editorStack = userStack;
      userStack.style.display = "none";
      const host = document.createElement("div");
      host.dataset.mehEditor = "";
      userRow.insertBefore(host, userStack.nextSibling);
      editorHost = host;
      editorRoot = ReactDOM.createRoot(host);
      editorRoot.render(React.createElement(InlineEditor, {
        initialText: text,
        onSave: handleSave,
        onCancel: endEditing,
      }));
      requestAnimationFrame(() => {
        const textarea = host.querySelector("textarea");
        if (textarea === null) return;
        textarea.focus();
        try { textarea.setSelectionRange(textarea.value.length, textarea.value.length); } catch {}
      });
    }

    /** 开始气泡内编辑：隐藏气泡区并原位挂载编辑器。 */
    function startEditing(row, text) {
      const userRow = row.querySelector("[data-time-hover-root]");
      if (userRow === null) return;
      if (editingState !== null) endEditing();
      editingState = { key: liveEdit.lastKey, text };
      mountEditor(row, text);
    }

    /** 结束编辑：卸载编辑器、移除挂载点、恢复气泡区显示。 */
    function endEditing() {
      if (editorRoot !== null) {
        try { editorRoot.unmount(); } catch {}
        editorRoot = null;
      }
      if (editorHost !== null) {
        editorHost.remove();
        editorHost = null;
      }
      if (editorStack !== null) {
        editorStack.style.display = "";
        editorStack = null;
      }
      editingState = null;
    }

    /** 保存：空文本不发送。走「fork 分支重新生成」：
     *  fork 到最后一条 user 消息之前的 completed turn 边界（子会话不含旧
     *  消息与旧回复）→ 切到子会话 → 发送编辑文本（模型重新回答）→ 归档原
     *  会话（DSH 无真删除 API，归档=从列表移除且可恢复，观感等同删除）。
     *  任一环节失败均保留原会话，绝不造成数据丢失。 */
    function handleSave(text) {
      const trimmed = String(text ?? "").trim();
      if (trimmed === "") return;
      const sessionId = liveEdit.sessionId;
      endEditing();
      // 保存依赖三层能力：sessions service（fork/create/open）、workspaces
      // service（归档）、connection 层 prompt（发送）。
      if (sessionId === null
        || typeof sessionsService?.fork !== "function"
        || typeof sessionsService?.open !== "function"
        || typeof workspacesService?.archiveSession !== "function"
        || connectionApi === null
        || typeof connectionApi.sessions?.prompt !== "function") {
        console.warn("message-enhancer: cannot resend — required apis unavailable", {
          sessionId,
          hasFork: typeof sessionsService?.fork === "function",
          hasOpen: typeof sessionsService?.open === "function",
          hasArchive: typeof workspacesService?.archiveSession === "function",
          hasPrompt: typeof connectionApi?.sessions?.prompt === "function",
        });
        return;
      }
      void forkEdit(sessionId, trimmed);
    }

    /** fork 分支重发（走 sessions service，与 DSH 原生 branch 按钮同一路径）。
     *  service.fork 返回 childId 字符串、失败 throw，且成功后子会话已同步
     *  进入列表（open 立即可用）。无边界（单轮会话无历史 turn 可截断，fork
     *  无法表达空前缀）时改为新建会话发送编辑文本。任一环节失败均保留原
     *  会话，绝不造成数据丢失。
     *  模型/权限是事件日志折叠状态，fork/create 的子会话取边界（或默认）
     *  值 —— 中途切换过的会话重发后会回退旧值，故 prompt 前把父会话
     *  「当前」模型选择与权限预设显式同步到子会话（尽力而为，失败仅告警
     *  不阻塞重发）。 */
    async function forkEdit(sessionId, text) {
      const boundary = liveEdit.boundarySeq;
      // fork 前先读父会话当前模型选择（RPC 权威值；失败则跳过模型同步）。
      let currentModel = null;
      if (typeof connectionApi.sessions.models === "function") {
        try {
          const response = await connectionApi.sessions.models({ sessionId });
          const current = response?.result?.ok === true ? response.result.value?.current ?? null : null;
          if (current !== null && typeof current.provider === "string" && typeof current.model === "string") currentModel = current;
          else console.warn("message-enhancer: resend models read rejected, model sync skipped", { sessionId });
        } catch (error) {
          console.warn("message-enhancer: resend models read failed, model sync skipped", { sessionId, error: error instanceof Error ? error.message : String(error) });
        }
      }
      // fork 前读父会话历史尾部，折叠权限三旋钮事件（permission/preset、
      // sandbox/mode、approval/policy）的最后一条 seq：用于判断子会话是否
      // 已继承当前权限——/permission 命令会在子会话留下可见的命令节点
      // （与手动切换权限相同），仅在必要时才发。读取失败则回退为总是同步。
      let lastKnobSeq = null;
      let knobFoldFailed = false;
      if (typeof connectionApi.sessions.history === "function") {
        try {
          const response = await connectionApi.sessions.history({ sessionId, maxMessages: 100 });
          if (response?.result?.ok === true) {
            const events = response.result.value?.events ?? [];
            for (const entry of events) {
              const type = entry?.event?.type;
              if (type === "permission/preset" || type === "sandbox/mode" || type === "approval/policy") {
                const seq = entry.event.seq;
                if (typeof seq === "number" && (lastKnobSeq === null || seq > lastKnobSeq)) lastKnobSeq = seq;
              }
            }
          } else {
            knobFoldFailed = true;
          }
        } catch {
          knobFoldFailed = true;
        }
      } else {
        knobFoldFailed = true;
      }
      let childId;
      if (boundary !== null) {
        // 多轮会话：fork 到最后一条 user 消息之前最近的 completed turn 边界。
        // 不传 increaseTitle：该参数会让宿主把子会话重命名为「原标题 (N)」，
        // 用于原生 branch 场景（原会话仍在列表需区分）；这里原会话随即归档、
        // 子会话取而代之，子会话直接继承原名即可，不追加剧号。
        try {
          childId = await sessionsService.fork({ sessionId, atSeq: boundary });
          console.info("message-enhancer: resend fork ok", { parent: sessionId, child: childId, atSeq: boundary });
        } catch (error) {
          console.warn("message-enhancer: resend fork failed, original session kept", { error: error instanceof Error ? error.message : String(error) });
          return;
        }
      } else {
        // 单轮会话：无历史 turn，fork 无法切出「空前缀」，改为新建会话
        // （继承原会话 cwd），语义等同「重发到干净分支」。
        const cwd = sessionsService.list?.getSnapshot?.().byId?.[sessionId]?.cwd;
        try {
          childId = await sessionsService.create(cwd === undefined ? {} : { cwd });
          console.info("message-enhancer: resend created fresh session", { parent: sessionId, child: childId });
        } catch (error) {
          console.warn("message-enhancer: resend create failed, original session kept", { error: error instanceof Error ? error.message : String(error) });
          return;
        }
      }
      if (typeof childId !== "string" || childId === "") {
        console.warn("message-enhancer: resend got no child session id, original session kept", { parent: sessionId });
        return;
      }
      // 切到子会话再发送/归档：service.fork/create 成功后子会话已在列表中，
      // open 立即可用；切换失败时贸然归档会把用户当前所在会话归档，故放弃。
      try {
        sessionsService.open(childId);
      } catch (error) {
        console.warn("message-enhancer: resend session switch failed, original session kept", { sessionId: childId, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      // —— 同步父会话当前模型选择（与 UI 选择器同一 RPC；失败仅告警）——
      if (currentModel !== null && typeof connectionApi.sessions.selectModel === "function") {
        try {
          const response = await connectionApi.sessions.selectModel({
            sessionId: childId,
            provider: currentModel.provider,
            model: currentModel.model,
            ...currentModel.reasoningEffort === undefined ? {} : { reasoningEffort: currentModel.reasoningEffort },
          });
          if (response?.result?.ok === true) console.info("message-enhancer: resend model synced", { sessionId: childId, provider: currentModel.provider, model: currentModel.model });
          else console.warn("message-enhancer: resend model sync rejected", { sessionId: childId, code: response?.result?.error?.code, message: response?.result?.error?.message });
        } catch (error) {
          console.warn("message-enhancer: resend model sync failed", { sessionId: childId, error: error instanceof Error ? error.message : String(error) });
        }
      }
      // —— 同步父会话当前权限预设（与 UI 权限选择器同一命令通道）——
      // 按需同步：fork 路径下，若父会话最后一个权限旋钮事件在边界之前
      // （子会话已继承该事件，权限本就一致）则跳过；create 路径下，父会话
      // 从未动过权限旋钮（与新建子会话同取全局默认）也跳过。历史读取失败
      // 时保守同步。"/permission" 只接受预设名；custom 无法用预设表达，跳过。
      const preset = liveEdit.permissionPreset;
      // fork 路径：最后一个权限事件在边界之前，或尾部窗口内没有权限事件
      // （事件要么不存在、要么早于窗口起点——窗口覆盖整个最后回合，早于
      // 窗口必早于边界）→ 子会话已继承当前权限。create 路径：单轮会话日志
      // 很短、窗口即全量，null 表示从未动过权限 → 与新会话同取全局默认。
      const inherited = !knobFoldFailed
        && (boundary !== null
          ? lastKnobSeq === null || lastKnobSeq <= boundary
          : lastKnobSeq === null);
      const skipReason = inherited
        ? "inherited"
        : preset === "custom"
          ? "custom"
          : typeof preset !== "string" || preset === ""
            ? "unavailable"
            : null;
      if (skipReason !== null) {
        console.info("message-enhancer: resend permission sync skipped", { sessionId: childId, reason: skipReason, preset, lastKnobSeq, boundary });
      } else {
        try {
          const childSession = sessionsService.binding?.(childId)?.session;
          if (typeof childSession?.command === "function") {
            const result = await childSession.command(`/permission ${preset}`);
            if (result?.ok === true && result.value?.matched === true) console.info("message-enhancer: resend permission synced", { sessionId: childId, preset });
            else console.warn("message-enhancer: resend permission sync not matched", { sessionId: childId, preset, ok: result?.ok, matched: result?.value?.matched });
          } else {
            console.warn("message-enhancer: resend permission sync skipped — child session binding unavailable", { sessionId: childId, preset });
          }
        } catch (error) {
          console.warn("message-enhancer: resend permission sync failed", { sessionId: childId, preset, error: error instanceof Error ? error.message : String(error) });
        }
      }
      // 发送编辑文本。connection 层 prompt 业务失败不 reject（返回
      // result.ok=false），必须显式检查；失败不归档原会话。
      let prompted = false;
      try {
        const response = await connectionApi.sessions.prompt({ sessionId: childId, mode: "queue", content: [{ type: "text", text }] });
        const failure = response?.result?.ok === true ? null : response?.result?.error ?? null;
        if (failure === null) prompted = true;
        else console.warn("message-enhancer: resend prompt rejected, original session kept", { sessionId: childId, code: failure.code, message: failure.message });
      } catch (error) {
        console.warn("message-enhancer: resend prompt failed, original session kept", { sessionId: childId, error: error instanceof Error ? error.message : String(error) });
      }
      if (!prompted) return;
      console.info("message-enhancer: resend prompted in child session", { sessionId: childId });
      // 归档原会话（workspaces service，失败 throw；失败仅提示，原会话保留）。
      try {
        await workspacesService.archiveSession(sessionId);
        console.info("message-enhancer: resend archived original session", { sessionId });
      } catch (error) {
        console.warn("message-enhancer: resend archive failed, original session kept", { sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    }

    /** 气泡内编辑器：textarea + 发送/取消。Enter 发送、Shift+Enter 换行、
     *  中文输入法组合期间不误提交；输入内容实时同步 editingState 防重建丢字。 */
    function InlineEditor({ initialText, onSave, onCancel }) {
      const [text, setText] = React.useState(initialText);
      const composing = React.useRef(false);
      const textareaRef = React.useRef(null);

      const commit = () => {
        const value = text.trim();
        if (value === "") return;
        onSave(value);
      };

      const onKeyDown = (event) => {
        if (event.key === "Enter" && !event.shiftKey && !composing.current) {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      };

      const onChange = (event) => {
        const value = event.target.value;
        setText(value);
        if (editingState !== null) editingState.text = value;
        // 自动高度：先复位再按 scrollHeight 撑开，封顶 240px。
        const textarea = textareaRef.current;
        if (textarea !== null) {
          textarea.style.height = "auto";
          textarea.style.height = Math.min(textarea.scrollHeight, 240) + "px";
        }
      };

      return React.createElement("div", { className: "meh-edit-editor" },
        React.createElement("textarea", {
          ref: textareaRef,
          className: "meh-edit-input",
          value: text,
          rows: 3,
          "aria-label": editT("edit"),
          onChange,
          onCompositionStart: () => { composing.current = true; },
          onCompositionEnd: () => { composing.current = false; },
          onKeyDown,
        }),
        React.createElement("div", { className: "meh-edit-actions" },
          React.createElement("button", {
            type: "button",
            className: "meh-edit-cancel",
            onClick: onCancel,
          }, editT("cancel")),
          React.createElement("button", {
            type: "button",
            className: "meh-edit-save",
            disabled: text.trim() === "",
            onClick: commit,
          }, editT("save")),
        ),
      );
    }

    /** fit 循环：注入/刷新编辑按钮；编辑中若编辑器被 React 重渲染冲掉则
     *  用已输入内容重建（防丢字）。 */
    function fitEditUi() {
      if (editingState !== null) {
        removeEditMount();
        if (editorHost === null || !editorHost.isConnected) {
          const row = document.querySelector(anchorSelector(editingState.key));
          if (row !== null) mountEditor(row, editingState.text);
        }
        return;
      }
      if (!liveEdit.supported || liveEdit.lastKey === null || liveEdit.lastText === null) {
        removeEditMount();
        return;
      }
      const row = document.querySelector(anchorSelector(liveEdit.lastKey));
      if (row === null) {
        removeEditMount();
        return;
      }
      injectEditButton(row);
    }

    /** 会话数据控制器：不渲染任何 UI，把最后一条 user 消息的 key/text/seq、
     *  fork 边界与回复中状态同步到模块级 liveEdit，驱动 fit 循环。所有
     *  selector 都返回 string/number/boolean 原始值，避免宿主 useSession
     *  按引用比较的无限重渲染。 */
    function EditController({ useSession, useProjection }) {
      const lastKey = typeof useSession === "function"
        ? useSession((snapshot) => { const entry = lastUserEntry(snapshot?.chat); return entry ? entry.key : null; })
        : null;
      const lastText = typeof useSession === "function"
        ? useSession((snapshot) => { const entry = lastUserEntry(snapshot?.chat); return entry ? entry.text : null; })
        : null;
      const lastSeq = typeof useSession === "function"
        ? useSession((snapshot) => { const entry = lastUserEntry(snapshot?.chat); return entry ? entry.seq : null; })
        : null;
      const boundarySeq = typeof useSession === "function"
        ? useSession((snapshot) => { const entry = lastUserEntry(snapshot?.chat); return entry ? forkBoundarySeq(snapshot?.chat, entry.seq) : null; })
        : null;
      const running = typeof useSession === "function" ? useSession((snapshot) => snapshot?.running === true) : false;
      // 权限 projection（宿主 composer 同款 useProjection("permissions")）：
      // 按 cell 订阅（TodoDock 同款整取），渲染期抽取 currentValue 原始值
      // 做 effect 依赖，避免引用比较问题。fork 后同步权限到子会话用。
      const permissions = typeof useProjection === "function" ? useProjection("permissions") : null;
      const permissionPreset = typeof permissions?.currentValue === "string" ? permissions.currentValue : null;
      React.useEffect(() => {
        // 最后一条 user 消息变了（新消息 / 切换会话）：悬挂中的编辑状态
        // 必须结束，否则 fit 循环会一直走编辑分支、新会话按钮无法注入。
        if (editingState !== null && editingState.key !== lastKey) endEditing();
        liveEdit.lastKey = lastKey;
        liveEdit.lastText = lastText;
        liveEdit.lastSeq = lastSeq;
        liveEdit.boundarySeq = boundarySeq;
        liveEdit.running = running;
        liveEdit.permissionPreset = permissionPreset;
        if (typeof scheduleFit === "function") scheduleFit();
      }, [lastKey, lastText, lastSeq, boundarySeq, running, permissionPreset]);
      return null;
    }

    // ============================================================
    // 装配：一次挂载合并样式，注册标尺 / 计划卡 / 通用提醒设置 / 回合监听。
    // ============================================================
    function apply(ctx) {
      ctx.effect(mountStyles, "message-enhancer styles");

      // 功能一：输入 Dock 的消息与计划索引标尺。
      ctx.effect(() => ctx.slots.inject("conversation.input.dock", () => ctx.slots.register(
        { name: "conversation.input.dock", id: "message-enhancer", order: 50 },
        (props) => React.createElement(UserMessageRuler, {
          session: props.session,
          useSession: props.useSession,
        }),
      )), "message-enhancer dock entry");

      // 功能二：计划审批卡（原 plan-review-card）。
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "plan-review-card dictionaries");

      const PlanReviewEntry = createPlanReviewCard(ctx);
      ctx.effect(() => ctx.slots.inject("conversation.composer", () => ctx.slots.register({
        name: "conversation.composer",
        select: selectPlanReview,
        priority: -1,
        locale: NS,
      }, PlanReviewEntry)), "plan-review-card composer entry");

      const PlanHistoryToolView = createPlanHistoryToolView(ctx);
      ctx.effect(() => ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
        name: "tool.call.toolview",
        key: "exit_plan_mode",
        priority: -1,
        locale: NS,
      }, PlanHistoryToolView)), "plan-review-card history tool view");

      // 功能三：回复完成提醒设置（设置 → 通用）。
      ctx.effect(() => ctx.locale.register(ALERT_NS, { zh: ALERT_ZH, en: ALERT_EN }), "message-enhancer alert dictionaries");
      ctx.effect(() => ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "message-enhancer-alert-sound",
        order: 30,
        locale: ALERT_NS,
      }, AlertSoundSettingRow)), "message-enhancer sound setting");
      ctx.effect(() => ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "message-enhancer-alert-tone",
        order: 31,
        locale: ALERT_NS,
      }, AlertToneSettingRow)), "message-enhancer tone setting");
      ctx.effect(() => ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "message-enhancer-alert-notify",
        order: 32,
        locale: ALERT_NS,
      }, AlertNotifySettingRow)), "message-enhancer notification setting");

      // 回合监听器留在 session-scoped Slot，仅运行 hook，不渲染任何页面内容。
      ctx.effect(() => ctx.slots.inject("conversation.input.dock", () => ctx.slots.register(
        { name: "conversation.input.dock", id: "message-enhancer-alert-watch", order: 51 },
        (props) => React.createElement(TurnAlertWatch, { session: props.session }),
      )), "message-enhancer alert watcher");

      // 功能四：最后一条用户消息气泡编辑重发。
      editT = ctx.get("locale")?.bind?.(EDIT_NS) ?? ((key) => key);
      connectionApi = ctx.get("connection")?.api ?? null;
      // sessions service：fork/create/open（分支与切换）；workspaces service：
      // archiveSession（归档原会话）。当前会话 id 经 sessions service 订阅
      // （file-search 同款），驱动发送。
      sessionsService = ctx.get("sessions");
      workspacesService = ctx.get("workspaces");
      if (sessionsService !== null && typeof sessionsService.list?.subscribe === "function") {
        const followSession = () => {
          const state = sessionsService.list.getSnapshot();
          liveEdit.sessionId = state && typeof state.current === "string" ? state.current : null;
        };
        followSession();
        ctx.effect(() => sessionsService.list.subscribe(followSession), "message-enhancer edit session watch");
      }
      // 能力探测：任一依赖缺失（旧版宿主）或 react-dom 18+ 的 createRoot
      // 不可用时整体禁用编辑按钮。
      liveEdit.supported = typeof sessionsService?.fork === "function"
        && typeof sessionsService?.create === "function"
        && typeof sessionsService?.open === "function"
        && typeof workspacesService?.archiveSession === "function"
        && !!connectionApi
        && typeof connectionApi.sessions?.prompt === "function"
        && ReactDOM !== null
        && typeof ReactDOM.createRoot === "function";
      if (!liveEdit.supported) {
        console.warn("message-enhancer: edit-resend disabled — required apis unavailable", {
          hasFork: typeof sessionsService?.fork === "function",
          hasCreate: typeof sessionsService?.create === "function",
          hasOpen: typeof sessionsService?.open === "function",
          hasArchive: typeof workspacesService?.archiveSession === "function",
          hasPrompt: typeof connectionApi?.sessions?.prompt === "function",
          hasCreateRoot: typeof ReactDOM?.createRoot === "function",
        });
      }
      ctx.effect(() => ctx.locale.register(EDIT_NS, { zh: EDIT_ZH, en: EDIT_EN }), "message-enhancer edit dictionaries");
      ctx.effect(() => ctx.slots.inject("conversation.input.dock", () => ctx.slots.register(
        { name: "conversation.input.dock", id: "message-enhancer-edit-controller", order: 52 },
        (props) => React.createElement(EditController, { useSession: props.useSession, useProjection: props.useProjection }),
      )), "message-enhancer edit controller");
      // 注入循环：监听 body 变化，rAF 防抖后重注入编辑按钮 / 重建编辑器。
      if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
        let scheduled = false;
        const schedule = () => {
          if (scheduled) return;
          scheduled = true;
          requestAnimationFrame(() => {
            scheduled = false;
            fitEditUi();
          });
        };
        scheduleFit = schedule;
        const editObserver = new MutationObserver(schedule);
        editObserver.observe(document.body, { childList: true, subtree: true });
        schedule();
        ctx.effect(() => () => {
          editObserver.disconnect();
          removeEditMount();
          endEditing();
        }, "message-enhancer edit watcher cleanup");
      }
    }

    exports.apply = apply;
    // inject 取并集：审批卡需要 locale 与 timer，标尺仅需 slots。
    exports.inject = ["slots", "locale", "timer"];
    return module.exports;
  },
});

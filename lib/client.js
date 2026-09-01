// @dsh-external/dsh-session-manager — browser half.
//
// Registered through the client-modules system: this bundle is served at
// `/plugins/@dsh-external/dsh-session-manager/client.js`, executed once to register a
// factory under `window.__ModuleLoader__`, and materialized lazily. The factory
// returns the Cordis client plugin (`inject` + `apply`), which registers:
//
//   1. `settings.section`（order 40）— 会话管理设置页：
//        - 全量会话列表（含打开中/运行中标记、创建时间、最近更新时间、大小、工作目录）
//        - 排序：按创建日期 / 按最近更新，均可切换升序/降序
//        - 每行手动删除（两步确认；打开中/运行中的会话不可删）
//        - 手动批量删除：删除「最近更新」早于 maxAgeDays 天的所有会话
//        - 阈值可配置：批量删除阈值 / 会话数上限 / 日志大小上限在设置页编辑并保存
//          （保存在宿主 ~/.dsh/storages/dsh_session_manager.json，立即生效；
//          包内 config.json 仅作初始基线，「恢复默认」回到基线）
//   2. `shell.overlay` — 启动弹窗：总会话数量或总会话大小超出 config.json 阈值时
//      提示一次（每次页面加载最多弹一次），引导用户到设置页处理。
//
// Only `react` is required (a platform seed word). No JSX: build elements with
// React.createElement. Styles use `--dsw-alias-*` semantic tokens so the page
// follows the active theme.

window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-session-manager",
  factory: (require) => {
    var React = require("react");
    var module = { exports: {} };
    var exports = module.exports;

    var API = "/api/dsh-session-manager";
    var STYLE_ID = "dsh-session-manager-style";
    var CONFIRM_TTL_MS = 3000;
    var MIB = 1048576;

    // ---- theme tokens (DSH settings style language, same as 字体 panel) ----
    var sectionStyle = { display: "flex", flexDirection: "column", gap: 12, maxWidth: 720, color: "var(--dsw-alias-label-primary)" };
    var titleStyle = { margin: 0, fontSize: 16, lineHeight: "24px", fontWeight: 500, color: "var(--dsw-alias-label-primary)" };
    var introStyle = { margin: 0, fontSize: 14, lineHeight: "22px", color: "var(--dsw-alias-label-tertiary)" };
    var cardStyle = { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 };
    var hintStyle = { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" };
    var errorStyle = { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-state-error-primary)" };
    var successStyle = { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-state-success-primary)" };
    var btnStyle = {
      display: "inline-flex", alignItems: "center", gap: 6, height: 30, padding: "0 12px",
      border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8,
      background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)",
      fontSize: 13, lineHeight: "20px", cursor: "pointer"
    };
    var btnPrimaryStyle = {
      display: "inline-flex", alignItems: "center", gap: 6, height: 30, padding: "0 12px",
      border: "1px solid var(--dsw-alias-brand-primary)", borderRadius: 8,
      background: "var(--dsw-alias-button-primary-fill)", color: "var(--dsw-alias-label-primary-foreground)",
      fontSize: 13, lineHeight: "20px", cursor: "pointer"
    };
    var btnDangerStyle = {
      display: "inline-flex", alignItems: "center", gap: 6, height: 26, padding: "0 10px",
      border: "1px solid var(--dsw-alias-state-error-primary)", borderRadius: 7,
      background: "var(--dsw-alias-interactive-bg-hover-danger)", color: "var(--dsw-alias-state-error-primary)",
      fontSize: 12, lineHeight: "18px", cursor: "pointer"
    };

    // ---- helpers ----
    function fmtTime(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
      var d = new Date(ms);
      if (Number.isNaN(d.getTime())) return "—";
      return d.toLocaleString("zh-CN", { hour12: false });
    }

    function fmtRelative(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
      var diff = Date.now() - ms;
      if (diff < 0) return fmtTime(ms);
      var HOUR = 3600000, DAY = 86400000;
      if (diff < 60000) return "刚刚";
      if (diff < HOUR) return Math.floor(diff / 60000) + " 分钟前";
      if (diff < DAY) return Math.floor(diff / HOUR) + " 小时前";
      if (diff < 30 * DAY) return Math.floor(diff / DAY) + " 天前";
      return fmtTime(ms);
    }

    function fmtSize(bytes) {
      if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
      if (bytes < 1024) return bytes + " B";
      if (bytes < MIB) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / MIB).toFixed(2) + " MB";
    }

    function basename(path) {
      var p = String(path || "");
      var cut = p.replace(/[\\/]+$/, "");
      var idx = Math.max(cut.lastIndexOf("\\"), cut.lastIndexOf("/"));
      return idx >= 0 ? cut.slice(idx + 1) : cut;
    }

    function fetchList() {
      return fetch(API, { cache: "no-store" })
        .then(function (res) { return res.json(); });
    }

    function post(body) {
      return fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (res) { return res.json(); })
        .catch(function () { return { ok: false, error: "network" }; });
    }

    function statusChip(row) {
      var label, bg, fg;
      if (row.running) { label = "运行中"; bg = "var(--dsw-alias-state-error-primary)"; fg = "#fff"; }
      else if (row.live) { label = "打开中"; bg = "var(--dsw-alias-interactive-bg-hover)"; fg = "var(--dsw-alias-label-secondary)"; }
      else if (row.origin === "subagent") { label = "子代理"; bg = "var(--dsw-alias-interactive-bg-hover)"; fg = "var(--dsw-alias-label-tertiary)"; }
      else { label = "已结束"; bg = "var(--dsw-alias-interactive-bg-hover)"; fg = "var(--dsw-alias-label-tertiary)"; }
      return React.createElement("span", {
        style: {
          flex: "none", display: "inline-flex", alignItems: "center", height: 20,
          padding: "0 8px", borderRadius: 999, fontSize: 11, lineHeight: "18px",
          background: bg, color: fg, whiteSpace: "nowrap",
        },
      }, label);
    }

    function SegButton(props) {
      var active = props.active === true;
      return React.createElement("button", {
        type: "button",
        onClick: props.onClick,
        style: {
          height: 28, padding: "0 12px", borderRadius: 8, cursor: "pointer",
          border: active ? "1px solid var(--dsw-alias-brand-primary)" : "1px solid var(--dsw-alias-border-l2)",
          background: active ? "var(--dsw-alias-interactive-bg-hover)" : "var(--dsw-alias-bg-layer-1)",
          color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-tertiary)",
          fontSize: 12, lineHeight: "18px",
        },
      }, props.children);
    }

    /** 会话管理设置页。 */
    function SessionsPanel() {
      var stateTuple = React.useState({ status: "loading", sessions: [], config: null, stats: null, error: null });
      var st = stateTuple[0];
      var setState = stateTuple[1];
      var sortTuple = React.useState({ key: "updatedAt", desc: true });
      var sort = sortTuple[0];
      var setSort = sortTuple[1];
      var pruneTuple = React.useState({ busy: false, armed: false, message: null, error: null });
      var prune = pruneTuple[0];
      var setPrune = pruneTuple[1];
      var deleteTuple = React.useState({ busyId: null, armedId: null, error: null });
      var del = deleteTuple[0];
      var setDel = deleteTuple[1];
      var armTimer = React.useRef(null);
      // 阈值编辑草稿（字符串输入）+ 独立保存状态（避免被配置同步覆盖）
      var draftTuple = React.useState({ maxAgeDays: "", maxSessions: "", maxTotalSizeMB: "" });
      var draft = draftTuple[0];
      var setDraft = draftTuple[1];
      var configStatusTuple = React.useState({ busy: false, message: null, error: null });
      var cfgStatus = configStatusTuple[0];
      var setCfgStatus = configStatusTuple[1];

      var load = function () {
        fetchList().then(function (data) {
          if (data && data.ok === true) {
            setState({ status: "ready", sessions: data.sessions || [], config: data.config || null, stats: data.stats || null, error: null });
          } else {
            setState({ status: "ready", sessions: [], config: null, stats: null, error: (data && data.error) || "load-failed" });
          }
        }).catch(function (error) {
          setState({ status: "ready", sessions: [], config: null, stats: null, error: String(error) });
        });
      };

      React.useEffect(function () { load(); }, []);

      // 服务器配置到达后同步编辑草稿
      React.useEffect(function () {
        var cfg = st.config;
        if (cfg === null || cfg === undefined) return;
        setDraft({
          maxAgeDays: String(typeof cfg.maxAgeDays === "number" ? cfg.maxAgeDays : 30),
          maxSessions: String(typeof cfg.maxSessions === "number" ? cfg.maxSessions : 100),
          maxTotalSizeMB: String(typeof cfg.maxTotalSizeMB === "number" ? cfg.maxTotalSizeMB : 1024),
        });
      }, [st.config]);

      function setDraftField(key, value) {
        setDraft(function (prev) {
          var next = {};
          next[key] = value;
          return Object.assign({}, prev, next);
        });
      }

      function saveSettings() {
        if (cfgStatus.busy) return;
        var maxAgeDays = Number(draft.maxAgeDays);
        var maxSessions = Number(draft.maxSessions);
        var maxTotalSizeMB = Number(draft.maxTotalSizeMB);
        if (!Number.isFinite(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 36500) {
          setCfgStatus({ busy: false, message: null, error: "批量删除阈值须为 1~36500 天" });
          return;
        }
        if (!Number.isFinite(maxSessions) || maxSessions < 0 || maxSessions > 100000) {
          setCfgStatus({ busy: false, message: null, error: "会话数上限须为 0~100000（0 = 不检查）" });
          return;
        }
        if (!Number.isFinite(maxTotalSizeMB) || maxTotalSizeMB < 0 || maxTotalSizeMB > 1000000) {
          setCfgStatus({ busy: false, message: null, error: "日志大小上限须为 0~1000000 MB（0 = 不检查）" });
          return;
        }
        setCfgStatus({ busy: true, message: null, error: null });
        post({ action: "set-config", maxAgeDays: maxAgeDays, maxSessions: maxSessions, maxTotalSizeMB: maxTotalSizeMB })
          .then(function (result) {
            load();
            if (result && result.ok === true) {
              setCfgStatus({ busy: false, message: "已保存并生效", error: null });
            } else {
              setCfgStatus({ busy: false, message: null, error: (result && result.error) || "save-failed" });
            }
          });
      }

      function resetSettings() {
        if (cfgStatus.busy) return;
        setCfgStatus({ busy: true, message: null, error: null });
        post({ action: "reset-config" }).then(function (result) {
          load();
          if (result && result.ok === true) {
            setCfgStatus({ busy: false, message: "已恢复默认（config.json 基线）", error: null });
          } else {
            setCfgStatus({ busy: false, message: null, error: (result && result.error) || "reset-failed" });
          }
        });
      }

      var config = st.config || {};
      var stats = st.stats || {};
      var maxAgeDays = typeof config.maxAgeDays === "number" ? config.maxAgeDays : 0;
      var maxSessions = typeof config.maxSessions === "number" ? config.maxSessions : 0;
      var maxTotalSizeMB = typeof config.maxTotalSizeMB === "number" ? config.maxTotalSizeMB : 0;
      var count = typeof stats.count === "number" ? stats.count : (st.sessions ? st.sessions.length : 0);
      var totalSizeBytes = typeof stats.totalSizeBytes === "number" ? stats.totalSizeBytes : 0;
      var eligibleExpired = typeof stats.eligibleExpired === "number" ? stats.eligibleExpired : 0;
      var overCount = maxSessions > 0 && count > maxSessions;
      var overSize = maxTotalSizeMB > 0 && totalSizeBytes > maxTotalSizeMB * MIB;

      // 排序计算
      var rows = (st.sessions || []).slice();
      rows.sort(function (a, b) {
        var va = sort.key === "createdAt" ? a.createdAt : a.updatedAt;
        var vb = sort.key === "createdAt" ? b.createdAt : b.updatedAt;
        var cmp = (typeof va === "number" ? va : 0) - (typeof vb === "number" ? vb : 0);
        cmp = cmp || String(a.id).localeCompare(String(b.id));
        return sort.desc ? -cmp : cmp;
      });

      function clearArmTimer() {
        if (armTimer.current !== null) { clearTimeout(armTimer.current); armTimer.current = null; }
      }

      function armDelete(id) {
        if (del.busyId !== null || prune.busy) return;
        if (del.armedId === id) {
          clearArmTimer();
          setDel({ busyId: id, armedId: null, error: null });
          post({ action: "delete", id: id }).then(function (result) {
            if (result && result.ok === true) {
              load();
              setDel({ busyId: null, armedId: null, error: null });
            } else {
              setDel({ busyId: null, armedId: null, error: (result && result.error) || "delete-failed" });
            }
          });
          return;
        }
        setDel({ busyId: null, armedId: id, error: null });
        clearArmTimer();
        armTimer.current = setTimeout(function () {
          armTimer.current = null;
          setDel({ busyId: null, armedId: null, error: null });
        }, CONFIRM_TTL_MS);
      }

      function armPrune() {
        if (prune.busy) return;
        if (prune.armed) {
          clearArmTimer();
          setPrune({ busy: true, armed: false, message: null, error: null });
          post({ action: "delete-expired" }).then(function (result) {
            load();
            if (result && result.ok === true) {
              var r = result.result;
              var skipText = "";
              var skippedTotal = (r.skipped ? r.skipped.live + r.skipped.running + r.skipped.missing : 0);
              if (skippedTotal > 0) skipText = "（跳过 " + skippedTotal + " 个：使用中 " + (r.skipped.live + r.skipped.running) + "、异常 " + (r.skipped.missing || 0) + "）";
              setPrune({ busy: false, armed: false, message: "已删除 " + r.deleted + " 个过期会话" + skipText, error: null });
            } else {
              setPrune({ busy: false, armed: false, message: null, error: (result && result.error) || "batch-failed" });
            }
          });
          return;
        }
        clearArmTimer();
        setPrune({ busy: false, armed: true, message: null, error: null });
        armTimer.current = setTimeout(function () {
          armTimer.current = null;
          setPrune({ busy: false, armed: false, message: null, error: null });
        }, CONFIRM_TTL_MS);
      }

      React.useEffect(function () {
        return function () { clearArmTimer(); };
      }, []);

      var sortLabel = sort.desc ? "降序 ↓" : "升序 ↑";

      var rowsEl = rows.map(function (row) {
        var deletable = !row.live && !row.running && row.origin !== "subagent";
        var titleText = row.displayTitle || row.title || row.id;
        var cwdText = row.cwd ? basename(row.cwd) : null;
        var armed = del.armedId === row.id;
        var busy = del.busyId === row.id;
        var label = armed ? "确认删除？" : "删除";
        return React.createElement("div", {
          key: row.id,
          style: {
            display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
            border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 10,
            background: "var(--dsw-alias-bg-layer-1)",
          },
        },
          React.createElement("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
              React.createElement("span", {
                style: { fontSize: 13, fontWeight: 500, lineHeight: "20px", color: "var(--dsw-alias-label-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                title: titleText,
              }, titleText),
              statusChip(row),
              row.parentId ? React.createElement("span", { style: { fontSize: 11, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" } }, "父会话") : null
            ),
            React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "2px 12px", fontSize: 11, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" } },
              React.createElement("span", null, "创建 " + fmtTime(row.createdAt)),
              React.createElement("span", null, "更新 " + fmtTime(row.updatedAt) + "（" + fmtRelative(row.updatedAt) + "）"),
              React.createElement("span", null, "大小 " + fmtSize(row.sizeBytes)),
              cwdText !== null ? React.createElement("span", { title: row.cwd || "" }, cwdText) : null,
              React.createElement("span", { title: row.id, style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 } }, row.id)
            )
          ),
          React.createElement("button", {
            type: "button",
            title: deletable ? "永久删除该会话（记录与日志）" : "打开中/运行中的会话不可直接删除",
            disabled: !deletable || busy || prune.busy,
            onClick: function () { armDelete(row.id); },
            style: Object.assign({}, btnDangerStyle, {
              opacity: busy ? 0.5 : (deletable ? 1 : 0.35),
              cursor: deletable ? "pointer" : "not-allowed",
              background: armed ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-interactive-bg-hover-danger)",
              color: armed ? "#fff" : "var(--dsw-alias-state-error-primary)",
            }),
          }, busy ? "删除中…" : label)
        );
      });

      var fieldLabelStyle = { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap" };
      var fieldStyle = {
        width: 96, height: 28, padding: "0 8px",
        border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8,
        background: "var(--dsw-specific-input-major)", color: "var(--dsw-alias-label-primary)",
        fontSize: 12, lineHeight: "18px", outline: "none", boxSizing: "border-box",
      };
      function configField(label, key, min, hint) {
        return React.createElement("label", { style: { display: "inline-flex", alignItems: "center", gap: 6 } },
          React.createElement("span", { style: fieldLabelStyle }, label),
          React.createElement("input", {
            type: "number",
            min: min,
            style: fieldStyle,
            value: draft[key],
            title: hint,
            disabled: cfgStatus.busy,
            onChange: function (e) { setDraftField(key, e.target.value); },
          }),
          React.createElement("span", { style: { fontSize: 11, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" } }, hint)
        );
      }
      var settingsRow = React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px 16px", alignItems: "center" } },
        configField("批量删除阈值(天)", "maxAgeDays", 1, "1~36500"),
        configField("会话数上限(个)", "maxSessions", 0, "0 = 不检查"),
        configField("日志大小上限(MB)", "maxTotalSizeMB", 0, "0 = 不检查")
      );
      var settingsActions = React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
        React.createElement("button", { type: "button", style: btnStyle, onClick: saveSettings, disabled: cfgStatus.busy }, cfgStatus.busy ? "保存中…" : "保存"),
        React.createElement("button", { type: "button", style: btnStyle, onClick: resetSettings, disabled: cfgStatus.busy }, "恢复默认"),
        cfgStatus.message !== null ? React.createElement("span", { style: successStyle }, cfgStatus.message) : null,
        cfgStatus.error !== null ? React.createElement("span", { style: errorStyle }, cfgStatus.error) : null
      );

      var statusLine = React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px 12px", alignItems: "center", fontSize: 12, lineHeight: "18px" } },
        React.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)" } },
          "当前：会话 " + count + " 个 · 日志总大小 " + fmtSize(totalSizeBytes) +
          (maxAgeDays > 0 ? " · 逾期货 " + eligibleExpired + " 个" : "")),
        overCount
          ? React.createElement("span", { style: { color: "var(--dsw-alias-state-error-primary)" } }, "会话数超限！")
          : null,
        overSize
          ? React.createElement("span", { style: { color: "var(--dsw-alias-state-error-primary)" } }, "日志大小超限！")
          : null
      );

      return React.createElement("div", { id: "dsh-session-manager-settings", style: sectionStyle },
        React.createElement("h3", { style: titleStyle }, "会话管理"),
        React.createElement("p", { style: introStyle }, "查看 DSH 全部会话（含已结束的持久化会话），按创建日期或最近更新排序；可逐条删除，或手动批量删除超过设定天数未更新的会话。"),

        React.createElement("div", { style: cardStyle },
          React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } },
              statusLine,
              React.createElement("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 } },
                React.createElement("button", { type: "button", style: btnStyle, onClick: load, disabled: prune.busy }, "刷新"),
                React.createElement("button", {
                  type: "button",
                  style: Object.assign({}, btnPrimaryStyle, { background: prune.armed ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-button-primary-fill)", borderColor: "var(--dsw-alias-state-error-primary)" }),
                  disabled: prune.busy || eligibleExpired <= 0,
                  title: eligibleExpired > 0 ? "删除全部超过 " + maxAgeDays + " 天未更新的会话" : "当前没有可删除的过期会话",
                  onClick: armPrune,
                  opacity: prune.busy ? 0.5 : (eligibleExpired > 0 ? 1 : 0.45),
                }, prune.busy ? "批量删除中…" : (prune.armed ? "确认批量删除？" : "批量删除（> " + maxAgeDays + " 天：" + eligibleExpired + " 个）"))
              )
            ),
            React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
              settingsRow,
              settingsActions
            )
          ),
          prune.message !== null ? React.createElement("p", { style: successStyle }, prune.message) : null,
          prune.error !== null ? React.createElement("p", { style: errorStyle }, "批量删除失败：" + prune.error) : null,
          overCount || overSize ? React.createElement("p", { style: errorStyle }, "超出告警阈值，建议调整上方阈值或清理过期会话（设置即时生效）。") : null
        ),

        st.error !== null
          ? React.createElement("div", { style: cardStyle },
              React.createElement("p", { style: errorStyle }, "会话列表加载失败：" + st.error),
              React.createElement("button", { type: "button", style: btnStyle, onClick: load }, "重试"))
          : null,

        React.createElement("div", { style: cardStyle },
          React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
            React.createElement("span", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" } }, "排序："),
            React.createElement(SegButton, { active: sort.key === "createdAt", onClick: function () { setSort({ key: "createdAt", desc: sort.desc }); } }, "创建日期"),
            React.createElement(SegButton, { active: sort.key === "updatedAt", onClick: function () { setSort({ key: "updatedAt", desc: sort.desc }); } }, "最近更新"),
            React.createElement("button", { type: "button", style: btnStyle, onClick: function () { setSort({ key: sort.key, desc: !sort.desc }); } }, sortLabel),
            React.createElement("span", { style: { marginLeft: "auto", fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" } },
              "共 " + count + " 个会话")
          ),
          del.error !== null ? React.createElement("p", { style: errorStyle }, "删除失败：" + del.error) : null,
          rows.length === 0
            ? React.createElement("p", { style: hintStyle }, st.status === "loading" ? "加载中…" : "暂无会话。")
            : React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, maxHeight: 480, overflowY: "auto", paddingRight: 4 } }, rowsEl)
        ),

        React.createElement("p", { style: hintStyle },
          "说明：删除会移除该会话的持久化记录（仅日志文件与空会话目录），不会触碰工作区文件；打开中或运行中的会话不可删除。三个阈值可直接在上方修改并保存（立即生效，保存在宿主 ~/.dsh/storages），包内 config.json 仅作初始基线；「恢复默认」回到基线值。")
      );
    }

    /** 启动弹窗：总会话数量 / 总大小超限时提示一次（每次页面加载至多一次）。 */
    function WarningOverlay() {
      var stateTuple = React.useState({ checked: false, show: false, count: 0, sizeBytes: 0, config: null, error: null });
      var st = stateTuple[0];
      var setState = stateTuple[1];
      var shownRef = React.useRef(false);

      React.useEffect(function () {
        if (shownRef.current) return;
        var tried = false;
        var timer = null;
        var attempt = function () {
          if (shownRef.current || tried) return;
          tried = true;
          fetchList().then(function (data) {
            if (shownRef.current) return;
            shownRef.current = true;
            if (data && data.ok === true) {
              var cfg = data.config || {};
              var stat = data.stats || {};
              var maxSessions = typeof cfg.maxSessions === "number" ? cfg.maxSessions : 0;
              var maxMB = typeof cfg.maxTotalSizeMB === "number" ? cfg.maxTotalSizeMB : 0;
              var overCount = maxSessions > 0 && stat.count > maxSessions;
              var overSize = maxMB > 0 && stat.totalSizeBytes > maxMB * MIB;
              if (!overCount && !overSize) {
                setState({ checked: true, show: false, count: 0, sizeBytes: 0, config: null, error: null });
                return;
              }
              setState({ checked: true, show: true, count: stat.count, sizeBytes: stat.totalSizeBytes, config: cfg, error: null });
            } else {
              setState({ checked: true, show: false, count: 0, sizeBytes: 0, config: null, error: (data && data.error) || "load-failed" });
            }
          }).catch(function () {
            // 首次失败：稍后重试一次（宿主路由可能在页面就绪瞬间尚未注册）
            if (shownRef.current || timer !== null) return;
            timer = setTimeout(attempt, 2500);
          });
        };
        attempt();
        return function () { if (timer !== null) clearTimeout(timer); };
      }, []);

      if (!st.show) return null;

      var cfg = st.config || {};
      var maxSessions = typeof cfg.maxSessions === "number" ? cfg.maxSessions : 0;
      var maxMB = typeof cfg.maxTotalSizeMB === "number" ? cfg.maxTotalSizeMB : 0;
      var overCount = maxSessions > 0 && st.count > maxSessions;
      var overSize = maxMB > 0 && st.sizeBytes > maxMB * MIB;
      var maxAgeDays = typeof cfg.maxAgeDays === "number" ? cfg.maxAgeDays : 30;

      var reasons = [];
      if (overCount) reasons.push("会话数量 " + st.count + " 个，超过上限 " + maxSessions + " 个");
      if (overSize) reasons.push("会话日志总大小 " + fmtSize(st.sizeBytes) + "，超过上限 " + fmtSize(maxMB * MIB));

      var dismiss = function () { setState({ checked: true, show: false, count: 0, sizeBytes: 0, config: null, error: null }); };

      return React.createElement("div", {
        style: {
          position: "fixed", inset: 0, zIndex: 1200,
          background: "rgba(0, 0, 0, 0.4)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 16,
        },
        onClick: function (event) { if (event.target === event.currentTarget) dismiss(); },
      },
        React.createElement("div", {
          style: {
            width: "100%", maxWidth: 460,
            background: "var(--dsw-alias-bg-base)",
            border: "1px solid var(--dsw-alias-border-l2)",
            borderRadius: 14,
            boxShadow: "var(--dsw-shadow-lv3, 0 8px 28px rgba(0,0,0,0.3))",
            padding: "16px 18px",
            display: "flex", flexDirection: "column", gap: 10,
            fontFamily: "var(--dsw-font-family)",
            color: "var(--dsw-alias-label-primary)",
          },
        },
          React.createElement("div", { style: { fontSize: 15, lineHeight: "22px", fontWeight: 600 } }, "会话存储超限提醒"),
          React.createElement("p", { style: { margin: 0, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-secondary)" } },
            "检测到以下情况："),
          React.createElement("ul", { style: { margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-secondary)" } },
            reasons.map(function (text, index) {
              return React.createElement("li", { key: "r" + index }, text);
            })),
          React.createElement("p", { style: { margin: 0, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-secondary)" } },
            "建议前往 设置 → 会话管理，手动批量删除超过 " + maxAgeDays + " 天未更新的会话，或在 config.json 调整告警上限。"),
          React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 } },
            React.createElement("button", {
              type: "button",
              onClick: dismiss,
              style: btnPrimaryStyle,
            }, "知道了")
          )
        )
      );
    }

    // ---- client 插件入口 ----
    module.exports = {
      name: "dsh-session-manager-client",
      inject: ["slots"],
      apply: function (ctx) {
        ctx.effect(function () {
          if (typeof document === "undefined") return;
          if (document.getElementById(STYLE_ID) !== null) return;
          var tag = document.createElement("style");
          tag.id = STYLE_ID;
          tag.dataset.plugin = "@dsh-external/dsh-session-manager";
          tag.textContent =
            "#dsh-session-manager-settings ::-webkit-scrollbar { width: 8px; } " +
            "#dsh-session-manager-settings ::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1); border-radius: 4px; }";
          document.head.appendChild(tag);
          return function () { tag.remove(); };
        });

        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register({
            name: "settings.section",
            id: "dsh-session-manager",
            order: 40,
            label: function () { return "会话管理"; },
            inject: function () { return {}; },
          }, SessionsPanel);
        });

        ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register({
            name: "shell.overlay",
            id: "dsh-session-manager-warning",
          }, WarningOverlay);
        });

        return function () {
          var tag = document.getElementById(STYLE_ID);
          if (tag !== null) tag.remove();
        };
      }
    };

    return module.exports;
  }
});

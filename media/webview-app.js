// kiro-dao-agent · webview app · v10.0.0 · 三重归元
// 道义: 三十二章 "道恒无名 · 侯王若能守之 · 万物将自宾"
// v10: SSE + postMessage 双通道 · Custom SP编辑 · 经藏切换
// 本文为 external script · 由 ext host webview.asWebviewUri 加载
// 端口从 body[data-port] 读 · 不依赖 inline script (VSCode webview 阻 inline)
(function () {
  "use strict";
  var _PORT = parseInt(document.body.getAttribute("data-port"), 10) || 0;
  var _BASE = "http://127.0.0.1:" + _PORT;

  // ═══════ 道 · 视诊 · 直写 #source ═══════
  function _src(t) {
    try {
      var s = document.getElementById("source");
      if (s) s.textContent = String(t).substring(0, 140);
    } catch (_) {}
  }
  _src("道·IIFE start·port=" + _PORT);

  window.addEventListener("error", function (e) {
    _src("错: " + ((e && e.message) || "?").substring(0, 80));
  });
  window.addEventListener("unhandledrejection", function (e) {
    var m = (e && e.reason && e.reason.message) || (e && e.reason) || "?";
    _src("rej: " + String(m).substring(0, 80));
  });

  // vsc API
  var vsc;
  try {
    vsc = acquireVsCodeApi();
  } catch (e) {
    vsc = {
      postMessage: function () {
        return false;
      },
      _ghost: true,
    };
  }
  if (vsc._ghost) _src("道·vsc-ghost");

  // 元素
  var $sp = document.getElementById("sp");
  var $meta = document.getElementById("meta");
  var $source = document.getElementById("source");
  var $dots = document.getElementById("dots");
  var $btnDao = document.getElementById("btnDao");
  var $btnOff = document.getElementById("btnOff");
  var $modeHint = document.getElementById("modeHint");
  var $refresh = document.getElementById("refresh");
  var $copy = document.getElementById("copy");
  var $ageTick = document.getElementById("ageTick");
  // 经文版本切换
  var $canonSelect = document.getElementById("canonSelect");
  // Custom SP 编辑
  var $editBar = document.getElementById("editBar");
  var $btnEdit = document.getElementById("btnEdit");
  var $btnSaveSP = document.getElementById("btnSaveSP");
  var $btnResetSP = document.getElementById("btnResetSP");
  var $spCharCount = document.getElementById("spCharCount");
  var $spEditor = document.getElementById("spEditor");

  var lastText = "";
  var curMode = "";
  var lastSig = "";
  var ageBase = null,
    ageTimer = null;
  // 经文缓存
  var _canonCache = { laozi: "", yinfu: "", full: "" };
  var _canonView = "full";
  // Custom SP 状态
  var _hasCustomSP = false;
  var _customSPText = "";
  var _defaultSPText = "";
  var _editing = false;

  // ═══════ HTTP ═══════
  function fJson(p) {
    return fetch(_BASE + p, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    });
  }
  function fPost(p, body) {
    return fetch(_BASE + p, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    }).then(function (r) {
      return r.json();
    });
  }

  // ═══════ 渲 ═══════
  function setModeUI(mode) {
    curMode = mode || "passthrough";
    $btnDao.classList.remove("active", "active-dao");
    $btnOff.classList.remove("active");
    // v10.3.1: 编按钮也参与互斥
    if ($btnEdit) $btnEdit.classList.remove("edit-active");
    if (curMode === "invert") {
      $btnDao.classList.add("active", "active-dao");
      $modeHint.textContent = "道";
    } else {
      $btnOff.classList.add("active");
      $modeHint.textContent = "官";
    }
    // v10.3.1: 道/官切换时退出编模式 · 三选一互斥
    if (_editing) {
      _editing = false;
      $spEditor.style.display = "none";
      $btnSaveSP.style.display = "none";
      $btnResetSP.style.display = "none";
      $sp.style.display = "";
    }
  }

  function setDots(dg) {
    $dots.innerHTML = "";
    if (!dg) return;
    var on = !!dg.proxy_up;
    var d = document.createElement("span");
    d.className = "dot " + (on ? "ok" : "err");
    $dots.appendChild(d);
    var tipBits = ["P:" + (on ? "✓" : "✗")];
    if (dg.mode) tipBits.push("M:" + dg.mode);
    $dots.title = tipBits.join(" · ");
  }

  function startAgeTick(s) {
    if (ageTimer) {
      clearInterval(ageTimer);
      ageTimer = null;
    }
    if (!$ageTick) return;
    if (s == null) {
      $ageTick.textContent = "";
      return;
    }
    ageBase = { s: s, at: Date.now() };
    var tick = function () {
      if (!ageBase) return;
      var c = ageBase.s + Math.round((Date.now() - ageBase.at) / 1000);
      $ageTick.textContent = c + "s前";
    };
    tick();
    ageTimer = setInterval(tick, 1000);
  }

  function showText(text, ts) {
    var changed = text !== lastText;
    lastText = text;
    $sp.classList.remove("quiet");
    $sp.innerHTML = "";
    $sp.textContent = text;
    $meta.textContent = text.length + "字 · " + ts;
    if (changed)
      try {
        $sp.scrollTop = 0;
      } catch (_) {}
  }

  // ═══════ 经文版本切换 ═══════
  // v10.3.1: 观照面板显示Kiro实时接收的SP · 非经文文本
  // 道模式: after=注入后SP · 官模式: after=原始Kiro SP · 皆Kiro实际接收
  function setCanonView(view) {
    _canonView = view;
    // 同步下拉框选中态
    if ($canonSelect) {
      var mapVal =
        { laozi: "laozi", yinfu: "yinfu", full: "laozi+yinfu" }[view] || view;
      if ($canonSelect.value !== mapVal) $canonSelect.value = mapVal;
    }
  }

  // ═══════ Custom SP 编辑 ═══════
  function showEditBar() {
    if ($editBar) $editBar.style.display = "flex";
  }
  function hideEditBar() {
    if ($editBar) $editBar.style.display = "none";
  }
  function toggleEdit() {
    _editing = !_editing;
    if (_editing) {
      // v10.3.1: 编模式 · 三选一 · 高亮编按钮 · 去道/官高亮
      if ($btnEdit) $btnEdit.classList.add("edit-active");
      $btnDao.classList.remove("active", "active-dao");
      $btnOff.classList.remove("active");
      $spEditor.style.display = "block";
      $spEditor.value = _hasCustomSP ? _customSPText : _defaultSPText || "";
      $btnSaveSP.style.display = "inline";
      $btnResetSP.style.display = _hasCustomSP ? "inline" : "none";
      $sp.style.display = "none";
      updateCharCount();
    } else {
      if ($btnEdit) $btnEdit.classList.remove("edit-active");
      $spEditor.style.display = "none";
      $btnSaveSP.style.display = "none";
      $btnResetSP.style.display = "none";
      $sp.style.display = "";
      // v10.3.1: 退出编 → 恢复道/官高亮
      setModeUI(curMode);
    }
  }
  function updateCharCount() {
    if ($spCharCount)
      $spCharCount.textContent = ($spEditor.value || "").length + "字";
  }
  function saveCustomSP() {
    var sp = $spEditor.value || "";
    vsc.postMessage({ command: "setCustomSP", sp: sp });
    _src("保存自定义SP…");
  }
  function resetCustomSP() {
    vsc.postMessage({ command: "resetCustomSP" });
    _src("归道(重置)…");
    // v10.3.1: 归道同时切回full经文模式
    fPost("/origin/canon", { canon: "full" })
      .then(function (cr) {
        if (cr && cr.ok) {
          if ($canonSelect && $canonSelect.value !== "laozi+yinfu")
            $canonSelect.value = "laozi+yinfu";
        }
      })
      .catch(function () {});
  }

  if ($btnEdit) $btnEdit.addEventListener("click", toggleEdit);
  if ($btnSaveSP) $btnSaveSP.addEventListener("click", saveCustomSP);
  if ($btnResetSP) $btnResetSP.addEventListener("click", resetCustomSP);
  if ($spEditor) $spEditor.addEventListener("input", updateCharCount);

  // ═══════ postMessage 处理 ═══════
  // v10: SSE + postMessage 双通道 · webview 接收 ext host 推送
  window.addEventListener("message", function (e) {
    if (!e || !e.data) return;
    var d = e.data;

    // ── data 推送: gatherEssence 结果 ──
    if (d.type === "data") {
      var _d = d.data;
      if (!_d) return;
      // ping/proxyUp → dots
      setDots({ proxy_up: !!_d.proxyUp, mode: _d.ping && _d.ping.mode });
      // mode
      if (_d.ping && _d.ping.mode)
        setModeUI(_d.ping.mode === "invert" ? "invert" : "passthrough");
      // 同步经文下拉框
      if (_d.ping && _d.ping.scripture_mode)
        setCanonView(_d.ping.scripture_mode);
      // v10.3.1: proxy.after → Kiro实时接收的SP · 本源
      if (_d.proxy && _d.proxy.after) {
        showText(_d.proxy.after, new Date().toLocaleTimeString());
        var modeLabel = _d.ping && _d.ping.mode === "invert" ? "道" : "官";
        var canonLabel = (_d.ping && _d.ping.scripture_mode) || "?";
        $source.textContent =
          modeLabel + " · " + _d.proxy.after.length + "字 · " + canonLabel;
        startAgeTick(_d.proxy.age_s);
      }
      // show edit bar when proxy is up
      if (_d.proxyUp) showEditBar();
      else hideEditBar();
      return;
    }

    // ── mode 推送: SSE mode 事件 ──
    if (d.type === "mode") {
      if (d.mode) setModeUI(d.mode === "invert" ? "invert" : "passthrough");
      return;
    }

    // ── customSP 推送 ──
    if (d.type === "customSP") {
      if (d.action === "get") {
        _hasCustomSP = !!d.has_custom;
        _customSPText = d.sp || "";
        _defaultSPText = d.default_sp || "";
        if (_editing) {
          $spEditor.value = _hasCustomSP ? _customSPText : _defaultSPText;
          updateCharCount();
        }
        _src(
          "自定义SP: " +
            (_hasCustomSP ? _customSPText.length + "字" : "无") +
            " · 默认" +
            (_defaultSPText ? _defaultSPText.length : 0) +
            "字",
        );
      } else if (d.action === "set") {
        if (d.ok) {
          _src("保存成功 · " + (d.chars || 0) + "字");
          _editing = false;
          $spEditor.style.display = "none";
          $btnSaveSP.style.display = "none";
          $sp.style.display = "";
        } else _src("保存失败 · " + (d.error || "?"));
      } else if (d.action === "reset") {
        if (d.ok) {
          _src("归道成功 · 回帛书老子+道藏阴符经");
          _hasCustomSP = false;
          _customSPText = "";
          if (_editing) {
            $spEditor.value = _defaultSPText || "";
            updateCharCount();
          }
          // v10.3.1: 归道后刷新观照面板
          setTimeout(function () {
            pull("reset-refresh");
          }, 500);
        } else _src("归道失败");
      }
      return;
    }

    // ── canonChanged 推送 ──
    if (d.type === "canonChanged") {
      if (d.default_sp) _defaultSPText = d.default_sp;
      if (d.canon) setCanonView(d.canon);
      _src(
        "经藏切换 · " +
          (d.canon_name || d.canon || "?") +
          " · " +
          (d.chars || 0) +
          "字",
      );
      if (_editing && !_hasCustomSP) {
        $spEditor.value = _defaultSPText;
        updateCharCount();
      }
      // v10.3.1: 切经文后刷新观照面板 · 显示Kiro实时接收的SP
      pull("canon-changed");
      return;
    }
  });

  // ═══════ 主拉 · 直 HTTP (后备) ═══════
  // v10.3.1: 观照面板映射Kiro实时接收的提示词 · 本源
  function pull(tag) {
    if (!_PORT) {
      _src("道·无端口·" + tag);
      return;
    }
    Promise.all([
      fJson("/origin/ping").catch(function (e) {
        return { _err: e.message };
      }),
      fJson("/origin/preview").catch(function (e) {
        return { _err: e.message };
      }),
    ])
      .then(function (arr) {
        var ping = arr[0],
          preview = arr[1];
        if (!ping || !ping.ok) {
          var em = ping && ping._err ? ping._err : "?";
          _src(
            "道·ping fail·" + String(em).substring(0, 40) + " (" + tag + ")",
          );
          return;
        }
        setDots({ proxy_up: true, mode: ping.mode });
        setModeUI(ping.mode === "invert" ? "invert" : "passthrough");
        // 同步经文下拉框
        if (ping.scripture_mode) setCanonView(ping.scripture_mode);
        var ts = new Date().toLocaleTimeString();
        // v10.3.1: 观照面板显示Kiro实时接收的SP (preview.after)
        // 道模式: after=注入后SP · 官模式: after=原始Kiro SP
        if (preview && preview.ok && preview.after) {
          showText(preview.after, ts);
          var modeLabel = ping.mode === "invert" ? "道" : "官";
          var canonLabel = ping.scripture_mode || "?";
          $source.textContent =
            modeLabel + " · " + preview.after.length + "字 · " + canonLabel;
          startAgeTick(preview.age_s);
        } else if (preview && preview.ok && preview.before) {
          // 有before无after: 道模式尚未注入(首次对话前)
          showText(preview.before, ts);
          $source.textContent = "原始 · " + preview.before.length + "字";
          startAgeTick(preview.age_s);
        } else {
          $sp.classList.add("quiet");
          $sp.textContent = "（待首次对话）";
          $source.textContent = "";
          startAgeTick(null);
        }
        showEditBar();
      })
      .catch(function (err) {
        _src("道·拉错·" + ((err && err.message) || "?").substring(0, 60));
      });
  }

  // ═══════ 按钮 ═══════
  $btnDao.addEventListener("click", function () {
    if (curMode === "invert" && !_editing) return;
    // v10.3.1: 点道即退出编 · 三选一
    if (_editing) {
      _editing = false;
      $spEditor.style.display = "none";
      $btnSaveSP.style.display = "none";
      $btnResetSP.style.display = "none";
      $sp.style.display = "";
    }
    setModeUI("invert");
    _src("切→道Agent…");
    vsc.postMessage({ command: "setMode", mode: "invert" });
  });
  $btnOff.addEventListener("click", function () {
    if (curMode === "passthrough" && !_editing) return;
    // v10.3.1: 点官即退出编 · 三选一
    if (_editing) {
      _editing = false;
      $spEditor.style.display = "none";
      $btnSaveSP.style.display = "none";
      $btnResetSP.style.display = "none";
      $sp.style.display = "";
    }
    setModeUI("passthrough");
    _src("切→官方Agent…");
    vsc.postMessage({ command: "setMode", mode: "passthrough" });
  });
  $refresh.addEventListener("click", function () {
    _src("刷新中…");
    vsc.postMessage({ command: "refresh" });
  });

  // 经文版本切换 → canonSelect → postMessage → proxy /origin/canon
  if ($canonSelect)
    $canonSelect.addEventListener("change", function () {
      vsc.postMessage({ command: "setCanon", canon: $canonSelect.value });
    });

  $copy.addEventListener("click", function () {
    var t = lastText || ($sp ? $sp.textContent : "");
    if (!t) {
      _src("复制·无文");
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(t)
        .then(function () {
          _src("复制·" + t.length + "字·成");
        })
        .catch(function (e) {
          _src("复制·错·" + ((e && e.message) || "?").substring(0, 40));
        });
    } else {
      var ta = document.createElement("textarea");
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {}
      document.body.removeChild(ta);
      _src("复制·" + t.length + "字·" + (ok ? "成" : "fail"));
    }
  });

  // ═══════ sig 轮询 · 后备 (SSE连接时降频) ═══════
  function sigTick() {
    fJson("/origin/sig")
      .then(function (r) {
        if (!r || !r.ok) return;
        var cur =
          r.mode +
          "|" +
          r.sp_sig +
          "|" +
          (r.custom_sig || "0") +
          "|" +
          (r.custom_sp_at || 0) +
          "|" +
          (r.injects_count || 0);
        if (cur === lastSig) return;
        lastSig = cur;
        pull("sig-tick");
      })
      .catch(function () {});
  }

  // 启
  pull("boot");
  // 请求 custom SP 状态
  vsc.postMessage({ command: "getCustomSP" });
  setTimeout(function () {
    pull("boot1");
  }, 800);
  setTimeout(function () {
    pull("boot2");
  }, 2500);
  // v10: 降低轮询频率 · SSE + postMessage 为主通道 · HTTP 为后备
  setInterval(sigTick, 5000);
  setInterval(function () {
    pull("tick");
  }, 30000);

  _src("道·IIFE end·SSE+postMessage·v10 (port=" + _PORT + ")");
})();

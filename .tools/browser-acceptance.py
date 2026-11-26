#!/usr/bin/env python3
"""Isolated, real-Chromium acceptance for Nova M1/M2/M3/M4/S1/S2/S5/S6/S8.

Also covers optional cross-tab conflict handling and accessibility semantics.
This file intentionally starts its own server and never targets an existing
service. All browser contexts are ephemeral and use synthetic state only.
HTTP(S) is denied by default; only the randomly selected acceptance origin is
allowed, except that file:// pages deny every HTTP(S) request (including the
legacy 8787 fallback). New scenarios use real DOM interaction or real page JS
entry points; assertions and evidence always come from the running page.
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

if not __debug__:
    raise SystemExit('browser-acceptance.py 不允许在 python -O / PYTHONOPTIMIZE 下运行')

from playwright.sync_api import sync_playwright


PROJECT = Path(__file__).resolve().parents[1]
TIMESTAMP = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
OUT_DIR = (PROJECT / ".tmp" / f"browser-acceptance-{TIMESTAMP}").resolve()
OUT_DIR.mkdir(parents=True, exist_ok=True)
STORE_FILE = OUT_DIR / "store.json"
REPORT_FILE = OUT_DIR / "report.json"
FILE_URL = (PROJECT / "index.html").resolve().as_uri()
FORBIDDEN_PATHS = {
    "/api/state",
    "/api/sync/ops",
    "/api/plan/review",
    "/api/replan/confirm",
    "/api/replan/undo",
}
REQUIRED = ("M1", "M2", "M3", "M4", "S1", "S2", "S5", "S6", "S8")
OPTIONAL = ("optional-7", "optional-6", "optional-concurrency", "optional-a11y", "optional-mobile", "optional-a4", "optional-a7", "optional-a8")

REPORT = {
    "schema": "nova-browser-acceptance-v2",
    "startedAt": datetime.now().astimezone().isoformat(),
    "project": str(PROJECT),
    "outputDir": str(OUT_DIR),
    "storeFile": str(STORE_FILE),
    "fileUrl": FILE_URL,
    "isolation": {
        "serverCommand": ["node", "server/main.js"],
        "serverEnv": {
            "PORT": "0",
            "HOST": "127.0.0.1",
            "NOVA_STORE_FILE": str(STORE_FILE),
            "NOVA_AUTH_SECRET": "synthetic-random-value-not-recorded",
            "NOVA_STORE_PARTITIONED": "0",
        },
        "browser": "ephemeral Chromium launch; new non-persistent context per scenario",
        "externalHttpPolicy": "abort by default; HTTP scenario allows only its random server origin",
        "fileHttpPolicy": "abort every HTTP(S) request, including 127.0.0.1:8787",
        "existing8787Used": False,
    },
    "server": {},
    "checks": {
        key: {"status": "pending", "pass": None, "evidence": {}, "error": None}
        for key in REQUIRED + OPTIONAL
    },
    "network": [],
    "pageErrors": [],
    "artifacts": [],
}


def log(message: str) -> None:
    print(f"[browser-acceptance] {message}", flush=True)


def write_report() -> None:
    checks = REPORT["checks"]
    REPORT["summary"] = {
        "required": {
            key: checks[key]["status"] for key in REQUIRED
        },
        "requiredAllPass": all(checks[key]["pass"] is True for key in REQUIRED),
        "optional": {
            key: checks[key]["status"] for key in OPTIONAL
        },
        "optionalAllPass": all(checks[key]["pass"] is True for key in OPTIONAL),
    }
    REPORT["finishedAt"] = datetime.now().astimezone().isoformat()
    tmp = REPORT_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(REPORT_FILE)


def artifact(path: Path) -> str:
    value = str(path.resolve())
    if value not in REPORT["artifacts"]:
        REPORT["artifacts"].append(value)
    return value


def evidence_screenshots(value) -> list[str]:
    found: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if isinstance(item, str) and (key == "screenshot" or key.endswith("Screenshot")):
                found.append(item)
            elif isinstance(item, (dict, list)):
                found.extend(evidence_screenshots(item))
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, (dict, list)):
                found.extend(evidence_screenshots(item))
    return found


def record(key: str, status: str, passed: bool | None, evidence: dict, error=None) -> None:
    shots = evidence_screenshots(evidence)
    REPORT["checks"][key] = {
        "status": status,
        "pass": passed,
        "evidence": evidence,
        "screenshot": shots[-1] if len(shots) == 1 else shots,
        "error": None if error is None else str(error),
    }
    write_report()
    log(f"{key}: {status} (pass={passed})")


def error_text(exc: BaseException) -> str:
    text = str(exc).strip()
    return text or exc.__class__.__name__


def screenshot(page, name: str) -> str:
    path = OUT_DIR / f"{name}.png"
    page.screenshot(path=str(path), full_page=False)
    return artifact(path)


def failure_screenshot(page, key: str, evidence: dict) -> None:
    if page is None or page.is_closed():
        evidence["screenshotError"] = "page unavailable at failure"
        return
    try:
        evidence["screenshot"] = screenshot(page, f"{key.lower()}-failure")
    except Exception as exc:
        evidence["screenshotError"] = error_text(exc)


def value_hash(value) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def send_message(page, text: str) -> None:
    page.locator("#input").fill(text)
    page.locator("#form .send").click()
    page.wait_for_function(
        "text => [...document.querySelectorAll('#chat .msg.u .txt')].some(el => el.textContent === text)",
        arg=text,
        timeout=10000,
    )
    page.wait_for_selector("#chat .typing", state="detached", timeout=15000)


def last_assistant_text(page) -> str:
    return page.evaluate(
        "() => [...document.querySelectorAll('#chat .msg.a .txt')].at(-1)?.textContent || ''"
    )


BUSINESS_SNAPSHOT_SCRIPT = r"""
() => {
  const S = ZX.state;
  return JSON.parse(JSON.stringify({
    tasks: S.tasks, placementModel: S.placementModel, goal: S.goal, feas: S.feas,
    week: S.week, weekShift: S.weekShift, dayAssign: S.dayAssign, buffer: S.buffer,
    locks: S.locks, sessions: S.sessions, consecutiveZeroDays: S.consecutiveZeroDays,
    interrupted: S.interrupted, rescueRecord: S.rescueRecord, replanned: S.replanned,
    snapshot: S.snapshot, replanRecord: S.replanRecord, replanHistory: S.replanHistory,
    tiredAdopted: S.tiredAdopted, movedOut: S.movedOut, tab: S.tab
  }));
}
"""


def business_snapshot(page) -> dict:
    return page.evaluate(BUSINESS_SNAPSHOT_SCRIPT)


def business_core(snapshot: dict) -> dict:
    return {key: value for key, value in snapshot.items() if key != "tab"}


def start_server() -> tuple[subprocess.Popen, str, list[str], list[str]]:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found")
    env = os.environ.copy()
    env.update({
        "PORT": "0",
        "HOST": "127.0.0.1",
        "NOVA_STORE_FILE": str(STORE_FILE),
        "NOVA_AUTH_SECRET": "browser-acceptance-" + secrets.token_hex(32),
        "NOVA_STORE_PARTITIONED": "0",
        "NODE_ENV": "test",
    })
    proc = subprocess.Popen(
        [node, "server/main.js"],
        cwd=str(PROJECT),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    lines: queue.Queue[str] = queue.Queue()
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    def read_stdout() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            stdout_lines.append(line.rstrip("\r\n"))
            lines.put(line)

    def read_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_lines.append(line.rstrip("\r\n"))

    threading.Thread(target=read_stdout, daemon=True).start()
    threading.Thread(target=read_stderr, daemon=True).start()
    deadline = time.monotonic() + 20
    url = None
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("server exited before URL: " + " | ".join(stderr_lines[-10:]))
        try:
            line = lines.get(timeout=0.1)
        except queue.Empty:
            continue
        match = re.search(r"http://127\.0\.0\.1:(\d+)", line)
        if match:
            port = int(match.group(1))
            if port == 8787:
                proc.terminate()
                raise RuntimeError("refusing legacy port 8787")
            url = f"http://127.0.0.1:{port}"
            break
    if not url:
        stop_server(proc)
        raise RuntimeError("timed out waiting for random server URL; stderr=" + " | ".join(stderr_lines[-10:]))
    REPORT["server"] = {
        "pid": proc.pid,
        "url": url,
        "port": urlparse(url).port,
        "stdout": stdout_lines,
        "stderr": stderr_lines,
    }
    log(f"isolated server ready at {url}")
    return proc, url, stdout_lines, stderr_lines


def stop_server(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=8)
    REPORT["server"]["exitCode"] = proc.returncode
    REPORT["server"]["terminated"] = True
    for stream in (proc.stdout, proc.stderr):
        if stream:
            stream.close()


def prefs_script(gl3d: bool) -> str:
    # gl3d 已废弃偏好读取，3D 舞台仅由 html[data-gl3d] 运行时闸门控制；
    # init script 在任何页面脚本（含首帧偏好脚本）前执行，直接设置该属性即可精确控制模式。
    return (
        "(()=>{const apply=()=>{const r=document.documentElement;if(!r)return false;"
        "r.dataset.gl3d='" + ("on" if gl3d else "off") + "';return true;};"
        "if(!apply()){const o=new MutationObserver(()=>{if(apply())o.disconnect();});"
        "o.observe(document,{childList:true,subtree:true});}"
        "localStorage.setItem('zx.ui_prefs',JSON.stringify({motion:false,grid:true,glow:true}));})()"
    )


MEASURE_SCRIPT = r"""
(() => {
  const m = window.__acceptanceMetrics || (window.__acceptanceMetrics = {
    rafCallbacks: 0, cloneNodeCalls: 0, measuring: false
  });
  const nativeClone = Node.prototype.cloneNode;
  if (!Node.prototype.__acceptanceWrapped) {
    Node.prototype.cloneNode = function(deep) {
      if (window.__acceptanceMetrics && window.__acceptanceMetrics.measuring) {
        window.__acceptanceMetrics.cloneNodeCalls += 1;
      }
      return nativeClone.call(this, deep);
    };
    Node.prototype.__acceptanceWrapped = true;
  }
  const nativeRaf = window.requestAnimationFrame.bind(window);
  if (!window.__acceptanceRafWrapped) {
    window.requestAnimationFrame = function(callback) {
      return nativeRaf(function(ts) {
        const metrics = window.__acceptanceMetrics;
        if (metrics && metrics.measuring) metrics.rafCallbacks += 1;
        return callback(ts);
      });
    };
    window.__acceptanceRafWrapped = true;
  }
  return true;
})()
"""


def new_context(browser, server_origin: str, *, file_mode: bool, gl3d: bool = False,
                force_local_replan: bool = False, measure: bool = False,
                viewport: dict | None = None, has_touch: bool = False, is_mobile: bool = False):
    context = browser.new_context(
        viewport=viewport or {"width": 1440, "height": 900},
        locale="zh-CN",
        timezone_id="Asia/Shanghai",
        accept_downloads=True,
        service_workers="block",
        reduced_motion="no-preference",
        has_touch=has_touch,
        is_mobile=is_mobile,
    )
    context.add_init_script(prefs_script(gl3d))
    if measure:
        context.add_init_script(MEASURE_SCRIPT)
    context._nova_file_mode = file_mode
    context._nova_force_local_replan = force_local_replan

    def route_handler(route, request):
        url = request.url
        parsed = urlparse(url)
        entry = {
            "scenario": context._nova_label,
            "url": url,
            "method": request.method,
            "resourceType": request.resource_type,
            "isNavigation": request.is_navigation_request(),
            "decision": None,
            "status": None,
            "failure": None,
        }
        REPORT["network"].append(entry)
        if parsed.scheme in ("http", "https"):
            if file_mode:
                entry["decision"] = "aborted-file-http"
                route.abort()
                return
            if f"{parsed.scheme}://{parsed.netloc}" != server_origin:
                entry["decision"] = "aborted-external"
                route.abort()
                return
            if force_local_replan and request.method == "POST" and parsed.path == "/api/replan":
                entry["decision"] = "aborted-intentional-local-replan-fallback"
                route.abort()
                return
            entry["decision"] = "allowed-acceptance-origin"
            route.continue_()
            return
        if parsed.scheme == "file" and file_mode:
            entry["decision"] = "allowed-local-file"
            route.continue_()
            return
        if parsed.scheme in ("data", "blob", "about"):
            entry["decision"] = "allowed-browser-internal"
            route.continue_()
            return
        entry["decision"] = "aborted-other-scheme"
        route.abort()

    context.route("**/*", route_handler)
    return context


def open_page(context, label: str, url: str, settle: float = 0.9):
    context._nova_label = label
    page = context.new_page()
    errors: list[str] = []

    def on_page_error(error) -> None:
        errors.append(error_text(error))
        REPORT["pageErrors"].append({"scenario": label, "error": error_text(error)})

    page.on("pageerror", on_page_error)
    page.goto(url, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector("#rail button[data-tab='chat']", state="attached", timeout=20000)
    page.wait_for_function("window.ZX && ZX.state && ZX.engine && ZX.flows", timeout=20000)
    page.wait_for_timeout(int(settle * 1000))
    return page, errors


def requests_for(label: str) -> list[dict]:
    return [row for row in REPORT["network"] if row.get("scenario") == label]


def forbidden_requests(labels: list[str]) -> list[dict]:
    rows = [row for row in REPORT["network"] if row.get("scenario") in labels]
    return [row for row in rows if urlparse(row["url"]).path in FORBIDDEN_PATHS]


def run_m1(browser, server_origin: str) -> None:
    evidence = {}
    context = None
    page = None
    label = "M1"
    try:
        context = new_context(browser, server_origin, file_mode=False, gl3d=False)
        page, errors = open_page(context, label, server_origin + "/")
        page.locator("#rail button[data-tab='plan']").click()
        page.locator("#view [data-goal-new]").click()
        page.locator("#saName").wait_for(state="visible", timeout=10000)
        goal_name = f"M1 隔离目标 {datetime.now().strftime('%Y%m%d-%H%M%S')}"
        deadline = page.evaluate(
            "() => ZX.util.isoDay(ZX.util.addDays(ZX.util.today0(), 420))"
        )
        page.locator("#saName").fill(goal_name)
        page.locator("#saDeadline").fill(deadline)
        page.locator("#saWeekly").fill("20")
        page.locator("[data-sa='next']").click()
        page.locator("[data-sa='decompose']").wait_for(state="visible", timeout=10000)
        assert page.locator("[data-sa='decompose']").is_enabled(), "goal failed feasibility gate"
        page.locator("[data-sa='decompose']").click()
        page.locator("[data-sa='confirm']").wait_for(state="visible", timeout=10000)
        draft = page.evaluate("""() => ({
          count: ZX.state.planDraft.length,
          ids: ZX.state.planDraft.map(item => item.id),
          minutes: ZX.state.planDraft.reduce((sum, item) => sum + item.est, 0),
          goalName: ZX.state.goalDraft.name,
          deadline: ZX.state.goalDraft.deadline
        })""")
        assert draft["count"] == 7 and draft["minutes"] == 405, draft
        evidence["uiDraft"] = draft
        evidence["goalCreationScreenshot"] = screenshot(page, "m1-goal-draft")
        page.locator("[data-sa='confirm']").click()
        page.wait_for_function(
            "() => ZX.state.placementModel && ZX.state.goalDraft === null && ZX.state.tab === 'plan'",
            timeout=20000,
        )
        page.locator("#view [data-pe-task]").first.wait_for(state="attached", timeout=10000)
        created = page.evaluate("""() => {
          const S = ZX.state, P = window.Rhythm.placementModel;
          const overlay = JSON.parse(localStorage.getItem('zx.overlay') || 'null');
          const projected = P.projectWeek(S.placementModel, S.tasks);
          const summary = P.summary(S.placementModel);
          return {
            today: ZX.util.todayKey(),
            browserTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            model: S.placementModel,
            tasks: S.tasks,
            week: S.week,
            weekShift: S.weekShift,
            goal: S.goal,
            taskDates: S.tasks.map(task => ({ id: task.id, date: task.date, time: task.time })),
            originals: Object.fromEntries(S.placementModel.placements.map(item => [item.taskId, item.originalSegments])),
            originalEqualsCurrent: S.placementModel.placements.every(item =>
              JSON.stringify(item.originalSegments) === JSON.stringify(item.currentSegments)),
            unplanned: S.placementModel.unplanned,
            expectedMinutes: S.tasks.reduce((sum, task) => sum + task.est, 0),
            weekMinutes: S.week.reduce((sum, day) => sum + day.total, 0),
            weekMatchesProjection: JSON.stringify(S.week) === JSON.stringify(projected),
            weekShiftMatchesProjection: JSON.stringify(S.weekShift) === JSON.stringify(projected),
            weekRowsOnlyActualUsage: S.week.every(day => day.total === day.normalUsed + day.bufferUsed),
            summary: summary.totals,
            overlayFormat: overlay && overlay.format,
            overlayVersion: overlay && overlay.version,
            overlayTaskIds: overlay ? overlay.tasks.map(task => task.id) : [],
            overlayModelMatches: !!overlay && JSON.stringify(overlay.placementModel) === JSON.stringify(S.placementModel)
          };
        }""")
        baseline_model = created.pop("model")
        assert created["browserTimezone"] == "Asia/Shanghai", created
        assert baseline_model["timezone"] == "Asia/Shanghai", baseline_model
        assert baseline_model["startDate"] == created["today"], baseline_model
        assert len(baseline_model["days"]) == 7
        assert [day["date"] for day in baseline_model["days"]] == [
            page.evaluate("offset => ZX.util.isoDay(ZX.util.addDays(ZX.util.today0(), offset))", offset)
            for offset in range(7)
        ]
        assert created["originalEqualsCurrent"] is True, created
        assert not created["unplanned"], created
        assert created["weekMinutes"] == created["expectedMinutes"] == 405, created
        assert created["weekMatchesProjection"] and created["weekShiftMatchesProjection"], created
        assert created["weekRowsOnlyActualUsage"], created
        assert created["summary"]["bufferUsedMin"] == 0, created
        assert created["summary"]["remainingBufferMin"] > 0, created
        assert created["overlayFormat"] == "nova-overlay" and created["overlayVersion"] == 3, created
        assert sorted(created["overlayTaskIds"]) == sorted(draft["ids"]), created
        assert created["overlayModelMatches"] is True, created
        assert all(row["date"] and row["time"] for row in created["taskDates"]), created
        created["modelSha256"] = value_hash(baseline_model)
        evidence["created"] = created
        evidence["createdScreenshot"] = screenshot(page, "m1-created-plan")

        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("window.ZX && ZX.state && ZX.state.placementModel", timeout=20000)
        page.locator("#rail button[data-tab='plan']").click()
        persisted = page.evaluate("""() => ({
          taskIds: ZX.state.tasks.map(task => task.id),
          model: ZX.state.placementModel,
          weekMatchesProjection: JSON.stringify(ZX.state.week) === JSON.stringify(
            window.Rhythm.placementModel.projectWeek(ZX.state.placementModel, ZX.state.tasks))
        })""")
        assert sorted(persisted["taskIds"]) == sorted(draft["ids"]), persisted
        assert persisted["model"] == baseline_model, "created placement model did not survive reload"
        assert persisted["weekMatchesProjection"] is True, persisted
        persisted.pop("model")
        evidence["reloadPersistence"] = persisted

        candidate = page.evaluate("""() => {
          const S = ZX.state, P = window.Rhythm.placementModel;
          const active = S.tasks.filter(task => !task.done && !task.skipped && !task.deferred &&
            !task.abandoned && !task.substituted);
          for (const task of active) {
            const segments = P.taskSegments(S.placementModel, task.id);
            if (!segments.length || segments.some(seg => seg.date !== segments[0].date)) continue;
            for (const day of S.placementModel.days) {
              if (day.date === segments[0].date) continue;
              const probe = ZX.flows.planedit.probe(task.id, day.date);
              if (probe && probe.ok && !probe.same) return {
                id: task.id, source: segments[0].date, target: day.date,
                minutes: segments.reduce((sum, seg) => sum + seg.durMin, 0)
              };
            }
          }
          return null;
        }""")
        assert candidate and candidate["source"] != candidate["target"], candidate
        requested_candidate = dict(candidate)
        evidence["dragAttempt"] = {"requested": requested_candidate}
        source = page.locator(
            f"[data-pe-task='{requested_candidate['id']}'][data-pe-date='{requested_candidate['source']}']"
        ).first
        target = page.locator(f"[data-pe-day='{candidate['target']}'] .sc2-col-b")
        page.evaluate("""() => {
          window.__m1DragEvents = [];
          for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) {
            document.addEventListener(type, event => {
              const task = event.target.closest?.('[data-pe-task]');
              const day = event.target.closest?.('[data-pe-day]');
              if (window.__m1DragEvents.length < 80) window.__m1DragEvents.push({
                type, taskId: task?.dataset.peTask || null,
                date: day?.dataset.peDay || null, defaultPrevented: event.defaultPrevented
              });
            }, true);
          }
        }""")
        evidence["dragSource"] = source.evaluate("""el => ({
          draggable: el.draggable, rect: el.getBoundingClientRect().toJSON(),
          html: el.outerHTML.slice(0, 500)
        })""")
        source.drag_to(target, force=True)
        page.wait_for_timeout(300)
        evidence["dragEvents"] = page.evaluate("() => window.__m1DragEvents")
        if not evidence["dragEvents"]:
            source_box = source.bounding_box()
            target_box = target.bounding_box()
            assert source_box and target_box, (source_box, target_box)
            page.mouse.move(source_box["x"] + source_box["width"] / 2, source_box["y"] + source_box["height"] / 2)
            page.mouse.down()
            page.mouse.move(target_box["x"] + target_box["width"] / 2, target_box["y"] + target_box["height"] / 2, steps=25)
            page.mouse.up()
            page.wait_for_timeout(500)
            evidence["dragEvents"] = page.evaluate("() => window.__m1DragEvents")
        dragged_id = next(
            (event["taskId"] for event in evidence["dragEvents"] if event["type"] == "dragstart"),
            None,
        )
        assert dragged_id in created["originals"], evidence["dragEvents"]
        task_id = dragged_id
        original_before = created["originals"][task_id]
        candidate = dict(requested_candidate)
        candidate["id"] = task_id
        candidate["minutes"] = sum(segment["durMin"] for segment in original_before)
        evidence["dragAttempt"]["actual"] = candidate
        page.wait_for_function(
            """([id, date]) => {
              const segments = ZX.state.taskSegments(id);
              return segments.length > 0 && segments.every(segment => segment.date === date);
            }""",
            arg=[task_id, candidate["target"]],
            timeout=10000,
        )
        moved = page.evaluate("""([id, date, sourceDate, original]) => {
          const S = ZX.state, P = window.Rhythm.placementModel;
          const placement = S.placementModel.placements.find(item => item.taskId === id);
          const task = S.tasks.find(item => item.id === id);
          const segments = P.taskSegments(S.placementModel, id);
          return {
            originalUnchanged: JSON.stringify(placement.originalSegments) === JSON.stringify(original),
            originalSegments: placement.originalSegments,
            currentSegments: segments,
            currentDates: [...new Set(segments.map(seg => seg.date))],
            taskDate: task.date,
            dayAssign: S.dayAssign[id],
            weekMatchesProjection: JSON.stringify(S.week) === JSON.stringify(P.projectWeek(S.placementModel, S.tasks)),
            weekShiftMatchesProjection: JSON.stringify(S.weekShift) === JSON.stringify(S.week),
            movedCount: ZX.flows.planedit.movedCount(),
            sourceDomBlocks: document.querySelectorAll(`[data-pe-task="${id}"][data-pe-date="${sourceDate}"]`).length,
            targetDomBlocks: document.querySelectorAll(`[data-pe-task="${id}"][data-pe-date="${date}"]`).length
          };
        }""", [task_id, candidate["target"], candidate["source"], original_before])
        assert moved["originalUnchanged"] is True, moved
        assert moved["currentDates"] == [candidate["target"]], moved
        assert moved["weekMatchesProjection"] and moved["weekShiftMatchesProjection"], moved
        assert moved["movedCount"] == 1 and moved["targetDomBlocks"] > 0, moved
        assert moved["sourceDomBlocks"] == 0, moved
        evidence["realDragTo"] = {"candidate": candidate, **moved}
        evidence["dragScreenshot"] = screenshot(page, "m1-drag-rescheduled")

        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("window.ZX && ZX.state && ZX.state.placementModel", timeout=20000)
        page.locator("#rail button[data-tab='plan']").click()
        moved_reload = page.evaluate("""([id, date, original]) => {
          const S = ZX.state, P = window.Rhythm.placementModel;
          const placement = S.placementModel.placements.find(item => item.taskId === id);
          return {
            taskDate: (S.tasks.find(task => task.id === id) || {}).date,
            currentDates: [...new Set(P.taskSegments(S.placementModel, id).map(seg => seg.date))],
            originalUnchanged: JSON.stringify(placement.originalSegments) === JSON.stringify(original),
            weekMatchesProjection: JSON.stringify(S.week) === JSON.stringify(P.projectWeek(S.placementModel, S.tasks))
          };
        }""", [task_id, candidate["target"], original_before])
        assert moved_reload["currentDates"] == [candidate["target"]], moved_reload
        assert moved_reload["originalUnchanged"] and moved_reload["weekMatchesProjection"], moved_reload
        evidence["dragReloadPersistence"] = moved_reload
        evidence["screenshot"] = screenshot(page, "m1-final-plan")
        evidence["pageErrors"] = errors
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        evidence["networkRequestCount"] = len(requests_for(label))
        assert not errors, errors
        assert not evidence["forbiddenApiRequests"], evidence["forbiddenApiRequests"]
        record("M1", "pass", True, evidence)
    except Exception as exc:
        evidence["pageErrors"] = locals().get("errors", [])
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        failure_screenshot(page, label, evidence)
        record("M1", "fail", False, evidence, exc)
    finally:
        if context:
            context.close()


def run_m3(browser, server_origin: str) -> None:
    evidence = {}
    context = None
    page = None
    label = "M3"
    try:
        context = new_context(browser, server_origin, file_mode=False, gl3d=False)
        page, errors = open_page(context, label, server_origin + "/")
        fixture = page.evaluate("""() => {
          const S = ZX.state, P = window.Rhythm.placementModel, U = ZX.util;
          const today = U.todayKey();
          const raw = [
            { id: 'm3-tired', title: 'M3 低权重暂缓任务', est: 40, weight: 0.05 },
            { id: 'm3-keep-a', title: 'M3 保留任务甲', est: 60, weight: 0.9 },
            { id: 'm3-keep-b', title: 'M3 保留任务乙', est: 30, weight: 0.8 }
          ];
          const tasks = raw.map(item => S.normTask({
            ...item, subject: '数学', s: '数学', date: today, time: '', done: false
          }));
          const model = P.createModel({
            startDate: today, timezone: 'Asia/Shanghai', idPrefix: 'm3_',
            slots: [{ date: today, startMin: 480, durMin: 180, available: true, isBuffer: false }],
            tasks: raw.map(item => ({ id: item.id, subject: '数学', estMin: item.est })),
            blocks: [
              { id: 'm3-b-tired', taskId: 'm3-tired', date: today, startMin: 480, durMin: 40 },
              { id: 'm3-b-a', taskId: 'm3-keep-a', date: today, startMin: 540, durMin: 60 },
              { id: 'm3-b-b', taskId: 'm3-keep-b', date: today, startMin: 610, durMin: 30 }
            ]
          });
          Object.assign(S, {
            tasks, placementModel: model, locks: {}, dayAssign: {}, sessions: [],
            goal: { name: 'M3 合成目标', source: 'user', target: '100 分', deadline: '2027-12-25', weeks: 20 },
            feas: { weeklyH: 20, weeks: 20, discount: 0.85, demand: 300 },
            replanned: false, snapshot: null, replanRecord: null, replanHistory: [],
            tiredAdopted: false, movedOut: null, consecutiveZeroDays: 0, interrupted: false,
            rescueRecord: null, skippedOpen: false
          });
          S.resetTimer();
          S.syncPlacementProjection();
          ZX.render();
          ZX.setTab('chat');
          return {
            today,
            model,
            dates: Object.fromEntries(tasks.map(task => [task.id, { date: task.date, time: task.time }])),
            segments: Object.fromEntries(tasks.map(task => [task.id, P.taskSegments(model, task.id)]))
          };
        }""")
        baseline_model = fixture.pop("model")
        baseline_segments = fixture.pop("segments")
        evidence["fixture"] = fixture
        send_message(page, "今天有点累")
        page.locator("#chat [data-act='tired']").last.wait_for(state="visible", timeout=10000)
        evidence["suggestionScreenshot"] = screenshot(page, "m3-tired-suggestion")
        page.locator("#chat [data-act='tired']").last.click()
        page.wait_for_function(
            "() => ZX.state.tasks.find(task => task.id === 'm3-tired')?.deferred === true"
        )
        adopted = page.evaluate("""baseline => {
          const S = ZX.state, P = window.Rhythm.placementModel;
          const id = 'm3-tired';
          const task = S.tasks.find(item => item.id === id);
          const rescue = ['compress', 'defer', 'downgrade'].map(key => {
            const option = ZX.flows.rescue.optionOf(key);
            return {
              key,
              candidateIds: (option.items || []).concat(option.dropped || []).map(item => item.id),
              includesDeferred: (option.items || []).concat(option.dropped || []).some(item => item.id === id)
            };
          });
          const replan = window.Rhythm.replan.replan(S.replanInput());
          return {
            task: { id: task.id, deferred: task.deferred, reason: task.deferredReason, date: task.date, time: task.time },
            activeIds: ZX.flows.exec.activeTasks().map(item => item.id),
            rescue,
            replanDiffIds: replan.diff.map(item => item.taskId),
            replanPlacementIds: (replan.nextPlacements || []).map(item => String(item.task.id)),
            sessionCount: S.sessions.length,
            done: task.done,
            modelUnchanged: JSON.stringify(S.placementModel) === JSON.stringify(baseline),
            currentSegments: P.taskSegments(S.placementModel, id)
          };
        }""", baseline_model)
        assert adopted["task"]["deferred"] is True and adopted["task"]["reason"] == "状态不佳", adopted
        assert adopted["task"]["date"] == fixture["dates"]["m3-tired"]["date"], adopted
        assert adopted["task"]["time"] == fixture["dates"]["m3-tired"]["time"], adopted
        assert "m3-tired" not in adopted["activeIds"], adopted
        assert all(not row["includesDeferred"] for row in adopted["rescue"]), adopted
        assert "m3-tired" not in adopted["replanDiffIds"], adopted
        assert "m3-tired" not in adopted["replanPlacementIds"], adopted
        assert adopted["sessionCount"] == 0 and adopted["done"] is False, adopted
        assert adopted["modelUnchanged"] is True, adopted
        assert adopted["currentSegments"] == baseline_segments["m3-tired"], adopted
        evidence["adopted"] = adopted

        page.locator("#rail button[data-tab='today']").click()
        today_dom = page.evaluate("""() => ({
          deferredText: document.querySelector('[data-deferred-list]')?.innerText || '',
          regularTaskCount: document.querySelectorAll('[data-task="m3-tired"]').length,
          timelineMentions: (document.querySelector('.tl')?.getAttribute('aria-label') || '').includes('M3 低权重暂缓任务'),
          restoreCount: document.querySelectorAll('[data-act="restore-deferred"][data-id="m3-tired"]').length
        })""")
        assert "M3 低权重暂缓任务" in today_dom["deferredText"], today_dom
        assert "计划日期未变" in today_dom["deferredText"], today_dom
        assert today_dom["regularTaskCount"] == 0 and today_dom["timelineMentions"] is False, today_dom
        assert today_dom["restoreCount"] == 1, today_dom
        evidence["todayDom"] = today_dom
        evidence["todayScreenshot"] = screenshot(page, "m3-today-deferred")

        page.locator("#rail button[data-tab='plan']").click()
        plan_dom = page.evaluate("""() => ({
          deferredText: document.querySelector('[data-deferred-list]')?.innerText || '',
          boardTaskCount: document.querySelectorAll('[data-pe-task="m3-tired"]').length,
          restoreCount: document.querySelectorAll('[data-act="restore-deferred"][data-id="m3-tired"]').length
        })""")
        assert "M3 低权重暂缓任务" in plan_dom["deferredText"], plan_dom
        assert "不计入计划板 · 计划日期未变" in plan_dom["deferredText"], plan_dom
        assert plan_dom["boardTaskCount"] == 0 and plan_dom["restoreCount"] == 1, plan_dom
        evidence["planDom"] = plan_dom
        evidence["planScreenshot"] = screenshot(page, "m3-plan-deferred")

        page.locator("[data-act='restore-deferred'][data-id='m3-tired']").click()
        page.wait_for_function(
            "() => !ZX.state.tasks.find(task => task.id === 'm3-tired')?.deferred"
        )
        restored = page.evaluate("""([baseline, dates, segments]) => {
          const S = ZX.state, P = window.Rhythm.placementModel;
          const task = S.tasks.find(item => item.id === 'm3-tired');
          return {
            task: { id: task.id, date: task.date, time: task.time, deferred: task.deferred },
            modelUnchanged: JSON.stringify(S.placementModel) === JSON.stringify(baseline),
            segmentsUnchanged: JSON.stringify(P.taskSegments(S.placementModel, task.id)) === JSON.stringify(segments),
            dateUnchanged: task.date === dates.date && task.time === dates.time,
            sessionCount: S.sessions.length,
            done: task.done,
            boardTaskCount: document.querySelectorAll('[data-pe-task="m3-tired"]').length,
            deferredListCount: document.querySelectorAll('[data-deferred-list]').length
          };
        }""", [baseline_model, fixture["dates"]["m3-tired"], baseline_segments["m3-tired"]])
        assert restored["modelUnchanged"] and restored["segmentsUnchanged"] and restored["dateUnchanged"], restored
        assert restored["sessionCount"] == 0 and restored["done"] is False, restored
        assert restored["boardTaskCount"] == 1 and restored["deferredListCount"] == 0, restored
        evidence["restored"] = restored
        evidence["screenshot"] = screenshot(page, "m3-restored-plan")
        evidence["pageErrors"] = errors
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        evidence["networkRequestCount"] = len(requests_for(label))
        assert not errors, errors
        assert not evidence["forbiddenApiRequests"], evidence["forbiddenApiRequests"]
        record("M3", "pass", True, evidence)
    except Exception as exc:
        evidence["pageErrors"] = locals().get("errors", [])
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        failure_screenshot(page, label, evidence)
        record("M3", "fail", False, evidence, exc)
    finally:
        if context:
            context.close()


def run_s2(browser, server_origin: str) -> None:
    evidence = {}
    context = None
    page = None
    label = "S2"
    try:
        context = new_context(browser, server_origin, file_mode=False, gl3d=False)
        page, errors = open_page(context, label, server_origin + "/")
        known = page.evaluate("""() => {
          const S = ZX.state;
          S.placementModel = null;
          S.tasks = [
            { id: 's2-done', title: 'S2 已完成', est: 60, plannedEst: 60, done: true, actual: 30 },
            { id: 's2-partial', title: 'S2 部分完成', est: 30, plannedEst: 100, partial: 50, completion: 50, actual: 70 },
            { id: 's2-open', title: 'S2 锁定待办', est: 60, plannedEst: 60, actual: 0 },
            { id: 's2-skipped', title: 'S2 已跳过', est: 50, plannedEst: 50, skipped: true, actual: 10 }
          ].map(item => S.normTask({ ...item, subject: '数学', s: '数学', weight: 0.5, done: !!item.done }));
          S.locks = { 's2-open': true };
          S.sessions = [];
          S.consecutiveZeroDays = 0;
          S.interrupted = false;
          S.rescueRecord = null;
          S.buffer = { time: '', free: true };
          ZX.setTab('today');
          const metrics = ZX.flows.exec.metrics();
          const stats = Object.fromEntries([...document.querySelectorAll('.vstats .vs')].map(el => [
            el.querySelector('span').textContent,
            { value: el.querySelector('b').textContent, note: el.querySelector('i')?.textContent || '' }
          ]));
          return { metrics, stats, statusText: document.querySelector('.sc-stats-note')?.textContent || '' };
        }""")
        metrics = known["metrics"]
        expected = {
            "total": 3, "done": 1, "taskRate": 1 / 3, "planned": 220,
            "plannedBasis": "known", "completedPlanned": 110, "plannedRate": 0.5,
            "worked": 110, "remain": 90, "partialCount": 1, "skipped": 1, "locked": 1,
        }
        for key, value in expected.items():
            assert abs(metrics[key] - value) < 1e-9 if isinstance(value, float) else metrics[key] == value, (key, metrics)
        assert known["stats"]["任务完成率"]["value"] == "33%", known
        assert known["stats"]["计划工时完成率"]["value"] == "50%", known
        assert known["stats"]["实际投入"]["value"] == "1h50", known
        assert known["stats"]["剩余预估"]["value"] == "1h30", known
        assert "部分完成 1 项" in known["statusText"] and "跳过 1 项" in known["statusText"], known
        assert "锁定 1 项" in known["statusText"], known
        evidence["knownDenominator"] = known
        evidence["knownScreenshot"] = screenshot(page, "s2-known-rates")

        unknown = page.evaluate("""() => {
          const S = ZX.state;
          S.tasks = [
            { id: 's2-u-done', title: 'S2 未知分母已完成', est: 60, done: true, actual: 20 },
            { id: 's2-u-partial', title: 'S2 旧部分任务', est: 30, partial: 50, completion: 50, actual: 10 }
          ].map(item => S.normTask({ ...item, subject: '数学', s: '数学', weight: 0.5, done: !!item.done }));
          S.locks = {};
          ZX.render();
          const metrics = ZX.flows.exec.metrics();
          const stats = Object.fromEntries([...document.querySelectorAll('.vstats .vs')].map(el => [
            el.querySelector('span').textContent,
            { value: el.querySelector('b').textContent, note: el.querySelector('i')?.textContent || '' }
          ]));
          return {
            metrics, stats,
            legacyHasPlannedEst: Object.hasOwn(S.tasks.find(task => task.id === 's2-u-partial'), 'plannedEst')
          };
        }""")
        metrics = unknown["metrics"]
        assert metrics["total"] == 2 and metrics["done"] == 1 and metrics["taskRate"] == 0.5, unknown
        assert metrics["planned"] == 60 and metrics["plannedBasis"] == "unknown", unknown
        assert metrics["plannedRate"] is None and metrics["rate"] is None, unknown
        assert metrics["worked"] == 30 and metrics["remain"] == 30 and metrics["partialCount"] == 1, unknown
        assert unknown["legacyHasPlannedEst"] is False, unknown
        assert unknown["stats"]["任务完成率"]["value"] == "50%", unknown
        assert unknown["stats"]["计划工时完成率"]["value"] == "未知", unknown
        assert unknown["stats"]["计划工时完成率"]["note"] == "旧任务缺原始计划", unknown
        assert unknown["stats"]["实际投入"]["value"] == "30m", unknown
        assert unknown["stats"]["剩余预估"]["value"] == "30m", unknown
        evidence["unknownDenominator"] = unknown
        evidence["screenshot"] = screenshot(page, "s2-unknown-rate")
        evidence["pageErrors"] = errors
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        evidence["networkRequestCount"] = len(requests_for(label))
        assert not errors, errors
        assert not evidence["forbiddenApiRequests"], evidence["forbiddenApiRequests"]
        record("S2", "pass", True, evidence)
    except Exception as exc:
        evidence["pageErrors"] = locals().get("errors", [])
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        failure_screenshot(page, label, evidence)
        record("S2", "fail", False, evidence, exc)
    finally:
        if context:
            context.close()


def run_s5(browser, server_origin: str) -> None:
    evidence = {}
    context = None
    page = None
    label = "S5"
    try:
        context = new_context(browser, server_origin, file_mode=False, gl3d=False)
        page, errors = open_page(context, label, server_origin + "/")
        fixture = page.evaluate("""() => {
          const S = ZX.state, P = window.Rhythm.placementModel, U = ZX.util;
          const today = U.todayKey();
          const endAt = U.addDays(U.today0(), -2).getTime() + 3600000;
          S.tasks = [S.normTask({
            id: 's5-task', title: 'S5 合成任务', subject: '数学', s: '数学',
            est: 60, weight: 0.8, date: today, time: '08:00–09:00'
          })];
          S.placementModel = P.createModel({
            startDate: today, timezone: 'Asia/Shanghai', idPrefix: 's5_',
            slots: [{ date: today, startMin: 480, durMin: 60, available: true, isBuffer: false }],
            tasks: [{ id: 's5-task', subject: '数学', estMin: 60 }],
            blocks: [{ id: 's5-block', taskId: 's5-task', date: today, startMin: 480, durMin: 60 }]
          });
          S.sessions = [{
            id: 's5-session', taskId: 's5-task', startAt: endAt - 60000, endAt,
            minutes: 0, completion: 0, status: 'skip', feel: null, isBackfill: false
          }];
          S.goal = { name: 'S5 合成目标', source: 'user', target: '100 分', deadline: '2027-12-25', weeks: 20 };
          S.feas = { weeklyH: 20, weeks: 20, discount: 0.85, demand: 300 };
          S.locks = {};
          S.consecutiveZeroDays = 0;
          S.interrupted = false;
          S.rescueRecord = null;
          S.resetTimer();
          S.syncPlacementProjection();
          ZX.render();
          ZX.setTab('chat');
          const detected = ZX.flows.rescue.detect();
          const R = ZX.flows.rescue;
          const native = { detect: R.detect, open: R.open, apply: R.apply, preview: R.preview };
          window.__s5Calls = { detect: 0, open: 0, apply: 0, preview: 0 };
          for (const name of Object.keys(native)) {
            R[name] = function (...args) {
              window.__s5Calls[name] += 1;
              return native[name].apply(this, args);
            };
          }
          return {
            today, sessionEndAt: endAt, threshold: R.THRESHOLD,
            zeroDays: R.zeroDaysFromSessions(), detected,
            consecutiveZeroDays: S.consecutiveZeroDays, interrupted: S.interrupted
          };
        }""")
        assert fixture["zeroDays"] == 2 and fixture["detected"] is False, fixture
        before_real = business_snapshot(page)
        send_message(page, "挽救")
        page.wait_for_function(
            "() => [...document.querySelectorAll('#chat .msg.a .txt')].at(-1)?.textContent.includes('尚未达到连续 3 天')",
            timeout=10000,
        )
        after_real = business_snapshot(page)
        real_dom = page.evaluate("""() => ({
          message: [...document.querySelectorAll('#chat .msg.a .txt')].at(-1)?.textContent || '',
          realDialogCount: document.querySelectorAll('.ovl[role="dialog"]').length,
          calls: window.__s5Calls
        })""")
        assert after_real == before_real, "sub-threshold rescue route changed business state"
        assert real_dom["realDialogCount"] == 0, real_dom
        assert real_dom["calls"]["detect"] == 1, real_dom
        assert real_dom["calls"]["open"] == 0 and real_dom["calls"]["apply"] == 0, real_dom
        evidence["realRoute"] = {
            **fixture, **real_dom,
            "businessSnapshotBeforeSha256": value_hash(before_real),
            "businessSnapshotAfterSha256": value_hash(after_real),
            "businessUnchanged": after_real == before_real,
        }
        evidence["realRouteScreenshot"] = screenshot(page, "s5-real-below-threshold")

        before_demo = business_snapshot(page)
        send_message(page, "演示挽救")
        page.wait_for_function(
            "() => [...document.querySelectorAll('#chat .msg.a .txt')].at(-1)?.textContent.includes('演示数据 · 不会修改真实计划')",
            timeout=10000,
        )
        after_demo = business_snapshot(page)
        demo_dom = page.evaluate("""() => {
          const last = [...document.querySelectorAll('#chat .msg.a')].at(-1);
          return {
            message: last?.querySelector('.txt')?.textContent || '',
            demoLabelCount: (last?.textContent.match(/演示数据 · 不会修改真实计划/g) || []).length,
            realDialogCount: document.querySelectorAll('.ovl[role="dialog"]').length,
            applyButtonCount: last?.querySelectorAll('[data-sb="apply"]').length || 0,
            calls: window.__s5Calls
          };
        }""")
        assert after_demo == before_demo, "demo rescue changed business state"
        assert demo_dom["demoLabelCount"] >= 2, demo_dom
        assert demo_dom["realDialogCount"] == 0 and demo_dom["applyButtonCount"] == 0, demo_dom
        assert demo_dom["calls"]["detect"] == 1, demo_dom
        assert demo_dom["calls"]["open"] == 0 and demo_dom["calls"]["apply"] == 0, demo_dom
        assert demo_dom["calls"]["preview"] == 1, demo_dom
        evidence["demoRoute"] = {
            **demo_dom,
            "businessSnapshotBeforeSha256": value_hash(before_demo),
            "businessSnapshotAfterSha256": value_hash(after_demo),
            "businessUnchanged": after_demo == before_demo,
        }
        evidence["screenshot"] = screenshot(page, "s5-demo-preview")
        evidence["pageErrors"] = errors
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        evidence["networkRequestCount"] = len(requests_for(label))
        assert not errors, errors
        assert not evidence["forbiddenApiRequests"], evidence["forbiddenApiRequests"]
        record("S5", "pass", True, evidence)
    except Exception as exc:
        evidence["pageErrors"] = locals().get("errors", [])
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        failure_screenshot(page, label, evidence)
        record("S5", "fail", False, evidence, exc)
    finally:
        if context:
            context.close()


def install_s6_fixture(page, capacities: list[int], *, locked: bool = False) -> dict:
    return page.evaluate("""([capacities, locked]) => {
      const S = ZX.state, P = window.Rhythm.placementModel, U = ZX.util;
      const today = U.todayKey();
      const dates = Array.from({ length: 7 }, (_, index) => U.isoDay(U.addDays(U.today0(), index)));
      const slots = dates.flatMap((date, index) => capacities[index] > 0 ? [{
        date, startMin: 480, durMin: capacities[index], available: true, isBuffer: false
      }] : []);
      const raw = [{ id: 's6-cross', subject: '数学', estMin: 60 }];
      const model = P.createModel({
        startDate: today, timezone: 'Asia/Shanghai', idPrefix: 's6_', slots, tasks: raw,
        blocks: [], unplanned: [{ taskId: 's6-cross', reason: 'S6 合成零基线待排' }]
      });
      S.tasks = [S.normTask({
        id: 's6-cross', title: 'S6 零基线跨日任务', subject: '数学', s: '数学',
        est: 60, weight: 0.9, date: null, time: '', unplanned: true,
        unplannedReason: 'S6 合成零基线待排'
      })];
      S.placementModel = model;
      S.locks = locked ? { 's6-cross': true } : {};
      Object.assign(S, {
        dayAssign: {}, sessions: [], replanned: false, snapshot: null, replanRecord: null,
        replanHistory: [], tiredAdopted: false, movedOut: null, consecutiveZeroDays: 0,
        interrupted: false, rescueRecord: null,
        goal: { name: 'S6 合成目标', source: 'user', target: '100 分', deadline: '2027-12-25', weeks: 20 },
        feas: { weeklyH: 20, weeks: 20, discount: 0.85, demand: 300 }
      });
      S.resetTimer();
      S.syncPlacementProjection();
      ZX.render();
      ZX.setTab('plan');
      return {
        today, dates, capacities, model, tasks: S.tasks, week: S.week,
        input: S.replanInput(), summary: P.summary(model).totals
      };
    }""", [capacities, locked])


def run_s6(browser, server_origin: str) -> None:
    evidence = {}
    context = None
    page = None
    label = "S6"
    try:
        context = new_context(
            browser, server_origin, file_mode=False, gl3d=False, force_local_replan=True
        )
        page, errors = open_page(context, label, server_origin + "/")
        fixture = install_s6_fixture(page, [30, 30, 0, 0, 0, 0, 0])
        baseline_model = fixture.pop("model")
        baseline_tasks = fixture.pop("tasks")
        baseline_week = fixture.pop("week")
        baseline_input = fixture.pop("input")
        assert fixture["summary"]["usedMin"] == 0, fixture
        assert all(day["minutes"] == 0 for day in baseline_input["week"]), baseline_input
        evidence["zeroBaseline"] = fixture

        page.locator("#view [data-replan-run]").first.click()
        page.wait_for_function(
            "() => [...document.querySelectorAll('#chat .msg.a .txt')].at(-1)?.textContent.includes('重排待确认')",
            timeout=15000,
        )
        preview = page.evaluate("""() => {
          const last = [...document.querySelectorAll('#chat .msg.a')].at(-1);
          const button = last?.querySelector('[data-act="confirm-replan"]');
          return {
            cardText: last?.querySelector('.txt')?.textContent || '',
            draftId: button?.dataset.draft || null,
            confirmButtonCount: last?.querySelectorAll('[data-act="confirm-replan"]').length || 0,
            engineSource: ZX.engine.source,
            replannedBeforeConfirmation: ZX.state.replanned,
            historyLengthBeforeConfirmation: ZX.state.replanHistory.length,
            usedMinutesBeforeConfirmation: ZX.state.placementSummary().totals.usedMin
          };
        }""")
        assert preview["draftId"] and preview["confirmButtonCount"] == 1, preview
        assert "增幅不适用（零基线）" in preview["cardText"], preview
        assert preview["engineSource"] == "local", preview
        assert preview["replannedBeforeConfirmation"] is False and preview["historyLengthBeforeConfirmation"] == 0, preview
        assert preview["usedMinutesBeforeConfirmation"] == 0, preview
        evidence["preview"] = preview
        page.locator("#rail button[data-tab='chat']").click()
        evidence["previewScreenshot"] = screenshot(page, "s6-zero-baseline-preview")
        page.locator("#chat .msg.a").last.locator("[data-act='confirm-replan']").click()
        page.wait_for_function("() => ZX.state.replanned === true", timeout=10000)
        confirmed = page.evaluate("""() => {
          const S = ZX.state, P = window.Rhythm.placementModel;
          const rec = S.replanRecord;
          const segments = P.taskSegments(S.placementModel, 's6-cross');
          return {
            loadDelta: rec.loadDelta,
            growthApplicable: rec.growthApplicable,
            verdict: rec.verdict,
            appliedLevel: rec.strategies.find(item => item.applied)?.level,
            nextPlacementSegments: rec.nextPlacements.find(item => String(item.task.id) === 's6-cross').segs,
            segments,
            segmentDates: segments.map(seg => seg.date),
            segmentMinutes: segments.map(seg => seg.durMin),
            allNormal: segments.every(seg => seg.isBuffer === false),
            taskEst: S.tasks.find(task => task.id === 's6-cross').est,
            weekTotals: S.week.map(day => day.total),
            weekMatchesProjection: JSON.stringify(S.week) === JSON.stringify(P.projectWeek(S.placementModel, S.tasks)),
            modelValid: !!P.normalizeModel(S.placementModel),
            history: S.replanHistory
          };
        }""")
        assert confirmed["loadDelta"] is None and confirmed["growthApplicable"] is False, confirmed
        assert confirmed["verdict"] == "ok" and confirmed["appliedLevel"] == 1, confirmed
        assert confirmed["segmentDates"] == fixture["dates"][:2], confirmed
        assert confirmed["segmentMinutes"] == [30, 30] and confirmed["allNormal"] is True, confirmed
        assert confirmed["nextPlacementSegments"] == [
            {"date": fixture["dates"][0], "minutes": 30, "isBuffer": False},
            {"date": fixture["dates"][1], "minutes": 30, "isBuffer": False},
        ], confirmed
        assert confirmed["taskEst"] == 60 and confirmed["weekTotals"] == [30, 30, 0, 0, 0, 0, 0], confirmed
        assert confirmed["weekMatchesProjection"] and confirmed["modelValid"], confirmed
        evidence["confirmed"] = confirmed
        page.locator("#rail button[data-tab='plan']").click()
        board = page.evaluate("""() => ({
          blockCount: document.querySelectorAll('[data-pe-task="s6-cross"]').length,
          crossDayLabels: [...document.querySelectorAll('[data-pe-task="s6-cross"]')].map(el => el.getAttribute('aria-label')),
          pageText: document.querySelector('#view').innerText,
          modelSha256: window.__s6ConfirmedHash || null
        })""")
        assert board["blockCount"] == 2, board
        assert all("跨日任务" in label for label in board["crossDayLabels"]), board
        assert "已重排 · 零基线，增幅不适用" in board["pageText"], board
        evidence["crossDayBoard"] = board
        evidence["confirmedScreenshot"] = screenshot(page, "s6-cross-day-confirmed")

        page.locator("[data-pe-lock='s6-cross']").first.click()
        page.wait_for_function("() => ZX.state.locks['s6-cross'] === true")
        locked_state = business_snapshot(page)
        page.locator("#rail button[data-tab='chat']").click()
        page.locator("#chat [data-act='undo']").last.click()
        page.wait_for_function(
            "() => [...document.querySelectorAll('#chat .msg.a .txt')].at(-1)?.textContent.includes('撤销冲突')",
            timeout=10000,
        )
        after_conflict = business_snapshot(page)
        conflict_message = last_assistant_text(page)
        assert business_core(after_conflict) == business_core(locked_state), "lock conflict undo changed plan, snapshot, or history"
        assert "整笔撤销已拒绝" in conflict_message, conflict_message
        assert after_conflict["replanned"] is True and after_conflict["snapshot"] is not None, after_conflict
        assert after_conflict["replanHistory"][-1]["undone"] is False, after_conflict
        evidence["lockConflictUndo"] = {
            "message": conflict_message,
            "businessSnapshotSha256": value_hash(locked_state),
            "businessUnchanged": business_core(after_conflict) == business_core(locked_state),
            "replanned": after_conflict["replanned"],
            "historyUndone": after_conflict["replanHistory"][-1]["undone"],
        }
        evidence["conflictScreenshot"] = screenshot(page, "s6-undo-lock-conflict")

        page.locator("#rail button[data-tab='plan']").click()
        page.locator("[data-pe-lock='s6-cross']").first.click()
        page.wait_for_function("() => !ZX.state.locks['s6-cross']")
        page.locator("#rail button[data-tab='chat']").click()
        page.locator("#chat [data-act='undo']").last.click()
        page.wait_for_function(
            "() => ZX.state.replanned === false && [...document.querySelectorAll('#chat .msg.a .txt')].at(-1)?.textContent.includes('已撤销')",
            timeout=10000,
        )
        undone = business_snapshot(page)
        assert undone["placementModel"] == baseline_model, "successful undo did not restore zero-baseline model"
        assert undone["tasks"] == baseline_tasks, "successful undo did not restore tasks"
        assert undone["week"] == baseline_week, "successful undo did not restore week projection"
        assert undone["locks"] == {} and undone["snapshot"] is None, undone
        assert undone["replanHistory"][-1]["undone"] is True, undone
        evidence["unlockUndoSuccess"] = {
            "modelRestored": undone["placementModel"] == baseline_model,
            "tasksRestored": undone["tasks"] == baseline_tasks,
            "weekRestored": undone["week"] == baseline_week,
            "locks": undone["locks"],
            "snapshotCleared": undone["snapshot"] is None,
            "historyUndone": undone["replanHistory"][-1]["undone"],
        }

        insufficient = install_s6_fixture(page, [20, 10, 0, 0, 0, 0, 0])
        insufficient_model = insufficient.pop("model")
        insufficient_tasks = insufficient.pop("tasks")
        insufficient_week = insufficient.pop("week")
        insufficient.pop("input")
        assert sum(insufficient["capacities"]) == 30 < 36, insufficient
        capacity_probe = page.evaluate("""() => {
          const input = ZX.state.replanInput();
          const natural = window.Rhythm.replan.replan({
            ...input, history: { consecutiveNoImprove: 0 }
          });
          ZX.state.replanHistory = Array.from({ length: 3 }, (_, index) => ({
            at: index + 1, loadDelta: null, appliedLevel: 1, undone: true
          }));
          const guardedInput = ZX.state.replanInput();
          const guarded = window.Rhythm.replan.replan(guardedInput);
          return {
            totalCapacity: input.week.reduce((sum, day) => sum + day.capacity, 0),
            compressFloorMinutes: Math.floor(input.tasks[0].est * input.params.compressFloor),
            locks: input.locks,
            capacityOnlyVerdict: natural.verdict,
            capacityOnlyAccepted: natural.accepted,
            capacityOnlyNeedsConfirmation: natural.needsConfirmation,
            capacityOnlyLoadDelta: natural.loadDelta,
            l1Applied: natural.strategies[0].applied,
            l1Reason: natural.strategies[0].reason,
            l4SuggestedAbandon: natural.diff.some(item => item.op === 'abandon'),
            flowVerdict: guarded.verdict,
            flowAccepted: guarded.accepted,
            flowNeedsConfirmation: guarded.needsConfirmation,
            flowLoadDelta: guarded.loadDelta,
            flowConsecutiveNoImprove: guardedInput.history.consecutiveNoImprove
          };
        }""")
        assert capacity_probe["totalCapacity"] == 30 and capacity_probe["compressFloorMinutes"] == 36, capacity_probe
        assert capacity_probe["l1Applied"] is False and "容量不足" in capacity_probe["l1Reason"], capacity_probe
        assert capacity_probe["capacityOnlyLoadDelta"] is None, capacity_probe
        assert capacity_probe["capacityOnlyAccepted"] is False and capacity_probe["capacityOnlyNeedsConfirmation"] is True, capacity_probe
        assert capacity_probe["l4SuggestedAbandon"] is True, capacity_probe
        assert capacity_probe["flowVerdict"] == "blocked" and capacity_probe["flowAccepted"] is False, capacity_probe
        assert capacity_probe["flowNeedsConfirmation"] is False and capacity_probe["flowLoadDelta"] is None, capacity_probe
        assert capacity_probe["flowConsecutiveNoImprove"] == 3, capacity_probe
        evidence["insufficientCapacity"] = {
            **insufficient, **capacity_probe,
            "note": "容量守卫单独拒绝 60 分钟装载；零基线 L4 仍会提出放弃建议。阻断确认分支同时启用既有连续 3 次未改善熔断，验证 blocked 时无确认入口且整笔不提交。"
        }
        page.locator("#view [data-replan-run]").first.click()
        page.wait_for_function(
            "() => [...document.querySelectorAll('#chat .msg.a .txt')].at(-1)?.textContent.includes('重排已停止')",
            timeout=15000,
        )
        before_confirm_attempt = business_snapshot(page)
        blocked_card = page.evaluate("""() => {
          const last = [...document.querySelectorAll('#chat .msg.a')].at(-1);
          return {
            text: last?.querySelector('.txt')?.textContent || '',
            confirmButtonCount: last?.querySelectorAll('[data-act="confirm-replan"]').length || 0,
            engineSource: ZX.engine.source
          };
        }""")
        assert blocked_card["confirmButtonCount"] == 0, blocked_card
        assert "防雪崩 · 转校准" in blocked_card["text"], blocked_card
        evidence["blockedPreview"] = blocked_card
        page.locator("#rail button[data-tab='chat']").click()
        evidence["blockedScreenshot"] = screenshot(page, "s6-capacity-blocked")
        confirmation_message = page.evaluate("""() => {
          ZX.flows.replan.confirmReplan();
          return [...document.querySelectorAll('#chat .msg.a .txt')].at(-1)?.textContent || '';
        }""")
        after_confirm_attempt = business_snapshot(page)
        assert "当前没有待确认的重排建议" in confirmation_message, confirmation_message
        assert business_core(after_confirm_attempt) == business_core(before_confirm_attempt), "blocked confirmation changed business state"
        assert after_confirm_attempt["replanned"] is False, after_confirm_attempt
        assert len(after_confirm_attempt["replanHistory"]) == 3, after_confirm_attempt
        assert all(row["undone"] is True for row in after_confirm_attempt["replanHistory"]), after_confirm_attempt
        assert after_confirm_attempt["placementModel"] == insufficient_model, after_confirm_attempt
        assert after_confirm_attempt["tasks"] == insufficient_tasks, after_confirm_attempt
        assert after_confirm_attempt["week"] == insufficient_week, after_confirm_attempt
        evidence["blockedConfirmation"] = {
            "message": confirmation_message,
            "businessUnchanged": business_core(after_confirm_attempt) == business_core(before_confirm_attempt),
            "replanned": after_confirm_attempt["replanned"],
            "historyLength": len(after_confirm_attempt["replanHistory"]),
            "taskEst": after_confirm_attempt["tasks"][0]["est"],
            "taskAbandoned": bool(after_confirm_attempt["tasks"][0].get("abandoned")),
        }
        evidence["screenshot"] = screenshot(page, "s6-final-blocked")
        evidence["pageErrors"] = errors
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        evidence["networkRequestCount"] = len(requests_for(label))
        assert not errors, errors
        assert not evidence["forbiddenApiRequests"], evidence["forbiddenApiRequests"]
        record("S6", "pass", True, evidence)
    except Exception as exc:
        evidence["pageErrors"] = locals().get("errors", [])
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        failure_screenshot(page, label, evidence)
        record("S6", "fail", False, evidence, exc)
    finally:
        if context:
            context.close()


def run_s8(browser, server_origin: str) -> None:
    evidence = {}
    context = None
    page = None
    label = "S8"
    try:
        context = new_context(browser, server_origin, file_mode=False, gl3d=False)
        page, errors = open_page(context, label, server_origin + "/")
        fixture = page.evaluate("""() => {
          const S = ZX.state, P = window.Rhythm.placementModel, U = ZX.util;
          const today = U.todayKey(), now = Date.now();
          const original = P.createModel({
            startDate: today, timezone: 'Asia/Shanghai', idPrefix: 's8_',
            slots: [{ date: today, startMin: 480, durMin: 30, available: true, isBuffer: false }],
            tasks: [{ id: 's8-skipped', subject: '数学', estMin: 30 }],
            blocks: [{ id: 's8-original', taskId: 's8-skipped', date: today, startMin: 480, durMin: 30 }]
          });
          const released = P.releaseTask(original, 's8-skipped', '已跳过', 's8_skip_');
          S.tasks = [S.normTask({
            id: 's8-skipped', title: 'S8 已跳过任务', subject: '数学', s: '数学',
            est: 30, weight: 0.5, date: today, time: '08:00–08:30', skipped: true,
            skipReason: '临时有事', skippedAt: now, done: false
          })];
          S.placementModel = released.model;
          S.locks = {};
          S.sessions = [{
            id: 's8-skip-session', taskId: 's8-skipped', startAt: now, endAt: now,
            minutes: 0, completion: 0, status: 'skip', feel: null, isBackfill: false
          }];
          Object.assign(S, {
            running: 's8-skipped', timerStart: now - 60000, pausedAt: null, pausedTotal: 0,
            replanned: false, snapshot: null, replanRecord: null, replanHistory: [],
            consecutiveZeroDays: 0, interrupted: false, rescueRecord: null, skippedOpen: true
          });
          S.syncPlacementProjection();
          ZX.render();
          ZX.setTab('today');
          return {
            today, originalModel: original, releasedModel: released.model,
            originalSegments: released.model.placements[0].originalSegments,
            taskDate: S.tasks[0].date, taskTime: S.tasks[0].time,
            sessionCount: S.sessions.length
          };
        }""")
        original_model = fixture.pop("originalModel")
        released_model = fixture.pop("releasedModel")
        original_segments = fixture.pop("originalSegments")
        evidence["fixture"] = fixture
        before_guards = business_snapshot(page)
        guard_calls = page.evaluate("""() => {
          const id = 's8-skipped';
          return {
            openRecordReturnedUndefined: ZX.flows.exec.openRecord(id) === undefined,
            finishTaskReturnedUndefined: ZX.assistant.finishTask(id, true) === undefined,
            commitRecordReturnedUndefined: ZX.flows.exec.commitRecord(id, 30, 100, '', 1, 2) === undefined,
            dialogCount: document.querySelectorAll('.ovl[role="dialog"]').length
          };
        }""")
        after_guards = business_snapshot(page)
        assert all(guard_calls[key] is True for key in (
            "openRecordReturnedUndefined", "finishTaskReturnedUndefined", "commitRecordReturnedUndefined"
        )), guard_calls
        assert guard_calls["dialogCount"] == 0, guard_calls
        assert after_guards == before_guards, "skipped task guard path changed business state"
        skipped_task = after_guards["tasks"][0]
        assert skipped_task["skipped"] is True and skipped_task["done"] is False, skipped_task
        assert len(after_guards["sessions"]) == fixture["sessionCount"] == 1, after_guards
        assert after_guards["placementModel"] == released_model, after_guards
        evidence["legacyEntryGuards"] = {
            **guard_calls,
            "businessUnchanged": after_guards == before_guards,
            "done": skipped_task["done"],
            "sessionCount": len(after_guards["sessions"]),
            "currentSegmentCount": window_value_length(after_guards["placementModel"], "s8-skipped"),
        }
        skipped_dom = page.evaluate("""() => ({
          skippedText: document.querySelector('.sc-skips')?.innerText || '',
          regularTaskCount: document.querySelectorAll('[data-task="s8-skipped"]').length,
          startButtonCount: document.querySelectorAll('[data-act="start"][data-id="s8-skipped"]').length,
          restoreButtonCount: document.querySelectorAll('[data-sc="restore"][data-id="s8-skipped"]').length
        })""")
        assert "S8 已跳过任务" in skipped_dom["skippedText"], skipped_dom
        assert skipped_dom["regularTaskCount"] == 0 and skipped_dom["startButtonCount"] == 0, skipped_dom
        assert skipped_dom["restoreButtonCount"] == 1, skipped_dom
        evidence["skippedDom"] = skipped_dom
        evidence["skippedScreenshot"] = screenshot(page, "s8-skipped-guards")

        started = page.evaluate("""() => {
          ZX.state.resetTimer();
          ZX.assistant.startTask('s8-skipped');
          const S = ZX.state, P = window.Rhythm.placementModel;
          const task = S.tasks.find(item => item.id === 's8-skipped');
          return {
            running: S.running, skipped: task.skipped, skipReason: task.skipReason,
            skippedAt: task.skippedAt, done: task.done, date: task.date, time: task.time,
            sessionCount: S.sessions.length,
            currentSegments: P.taskSegments(S.placementModel, task.id),
            originalSegments: S.placementModel.placements.find(item => item.taskId === task.id).originalSegments,
            timerStarted: !!S.timerStart
          };
        }""")
        assert started["running"] == "s8-skipped" and started["timerStarted"] is True, started
        assert started["skipped"] is False and started["skipReason"] is None and started["skippedAt"] is None, started
        assert started["done"] is False and started["sessionCount"] == 1, started
        assert started["date"] == fixture["taskDate"] and started["time"] == fixture["taskTime"], started
        assert len(started["currentSegments"]) == 1, started
        segment = started["currentSegments"][0]
        assert segment["date"] == fixture["today"] and segment["durMin"] == 30 and segment["isBuffer"] is False, started
        assert started["originalSegments"] == original_segments, started
        evidence["explicitStartRecovery"] = {
            **started,
            "entryPoint": "ZX.assistant.startTask（[data-act=start] 的真实页面处理器）"
        }
        page.locator("[data-task='s8-skipped']").wait_for(state="visible", timeout=10000)
        evidence["screenshot"] = screenshot(page, "s8-started-after-skip")
        evidence["pageErrors"] = errors
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        evidence["networkRequestCount"] = len(requests_for(label))
        assert not errors, errors
        assert not evidence["forbiddenApiRequests"], evidence["forbiddenApiRequests"]
        record("S8", "pass", True, evidence)
    except Exception as exc:
        evidence["pageErrors"] = locals().get("errors", [])
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        failure_screenshot(page, label, evidence)
        record("S8", "fail", False, evidence, exc)
    finally:
        if context:
            context.close()


def window_value_length(model: dict, task_id: str) -> int:
    placement = next((item for item in model["placements"] if item["taskId"] == task_id), None)
    return len(placement["currentSegments"]) if placement else 0


def run_m2(browser, server_origin: str) -> None:
    evidence = {}
    http_context = file_context = None
    try:
        http_context = new_context(
            browser, server_origin, file_mode=False, gl3d=False, force_local_replan=True
        )
        page, errors = open_page(http_context, "M2-http", server_origin + "/")
        evidence["http"] = {
            "title": page.title(),
            "initialTab": page.evaluate("document.documentElement.dataset.tab"),
            "gl3d": page.evaluate("document.documentElement.dataset.gl3d"),
        }
        assert evidence["http"]["title"] == "诺瓦 Nova · 大学生日常助理"
        assert evidence["http"]["initialTab"] == "chat"

        tabs = []
        for tab in ("today", "plan", "data", "me", "chat"):
            page.locator(f"#rail button[data-tab='{tab}']").click()
            page.wait_for_function(
                "tab => document.documentElement.dataset.tab === tab", arg=tab
            )
            tabs.append(tab)
        evidence["http"]["tabsVisited"] = tabs

        health_before = sum(
            1 for row in requests_for("M2-http") if urlparse(row["url"]).path == "/api/health"
        )
        page.evaluate("window.dispatchEvent(new Event('online'))")
        page.wait_for_function("ZX.api.isOnline() === true", timeout=10000)
        page.wait_for_timeout(500)
        health_after = sum(
            1 for row in requests_for("M2-http") if urlparse(row["url"]).path == "/api/health"
        )
        assert health_after > health_before, "online event did not trigger a health probe"
        evidence["http"]["onlineEvent"] = {
            "healthRequestsBefore": health_before,
            "healthRequestsAfter": health_after,
            "isOnline": page.evaluate("ZX.api.isOnline()"),
        }

        page.locator("#rail button[data-tab='plan']").click()
        page.locator("#view [data-replan-run]").first.click()
        page.locator("[data-act='confirm-replan']").wait_for(state="attached", timeout=20000)
        preview = page.evaluate("""() => ({
          source: ZX.engine.source,
          replanned: ZX.state.replanned,
          historyLength: (ZX.state.replanHistory || []).length,
          draftId: document.querySelector('[data-act="confirm-replan"]').dataset.draft,
          diffCount: (ZX.state.replanRecord && ZX.state.replanRecord.diff || []).length
        })""")
        assert preview["source"] == "local", preview
        assert preview["replanned"] is False, "preview must not commit before confirmation"
        assert preview["draftId"], "missing pending draft id"
        evidence["http"]["replanPreview"] = preview
        # The preview card belongs to chat; the flow intentionally switches to plan.
        page.locator("#rail button[data-tab='chat']").click()
        page.locator("[data-act='confirm-replan']").wait_for(state="visible", timeout=10000)
        evidence["http"]["replanPreviewScreenshot"] = screenshot(page, "m2-replan-preview")
        page.locator("[data-act='confirm-replan']").click()
        page.wait_for_function("ZX.state.replanned === true", timeout=10000)
        page.wait_for_function("document.body.innerText.includes('重排已确认')", timeout=10000)
        confirmed = page.evaluate("""() => ({
          replanned: ZX.state.replanned,
          historyLength: (ZX.state.replanHistory || []).length,
          lastHistory: (ZX.state.replanHistory || [])[(ZX.state.replanHistory || []).length - 1],
          confirmationMessageVisible: document.body.innerText.includes('重排已确认')
        })""")
        assert confirmed["replanned"] is True and confirmed["historyLength"] == 1
        assert confirmed["confirmationMessageVisible"] is True
        evidence["http"]["replanConfirmedLocally"] = confirmed
        evidence["http"]["screenshot"] = screenshot(page, "m2-http-confirmed")
        assert not errors, errors
        evidence["http"]["pageErrors"] = errors

        file_context = new_context(
            browser, server_origin, file_mode=True, gl3d=False, force_local_replan=False
        )
        file_page, file_errors = open_page(file_context, "M2-file", FILE_URL)
        schedule_result = file_page.evaluate("""async () => {
          const slots = [];
          for (let min = 480; min < 600; min += 30) {
            slots.push({date:'2099-01-01', startMin:min, durMin:30, available:true, isBuffer:false});
          }
          const result = await ZX.engine.schedule({
            tasks:[{id:'m2-local-task', subject:'数学', title:'隔离本机排程', estMin:60, weight:1}],
            slots:slots,
            params:{dailyCapMin:300, bufferRatio:0.15, maxContiguousMin:150}
          });
          return {
            source: ZX.engine.source,
            version: result.version,
            blockCount: result.blocks.length,
            placedMinutes: result.blocks.reduce((sum, block) => sum + block.durMin, 0),
            unplanned: result.unplanned
          };
        }""")
        assert schedule_result["source"] == "local", schedule_result
        assert schedule_result["blockCount"] > 0 and schedule_result["placedMinutes"] == 60
        file_page.wait_for_timeout(500)
        blocked_8787 = [
            row for row in requests_for("M2-file")
            if row["url"].startswith("http://127.0.0.1:8787")
        ]
        assert blocked_8787, "file:// fallback did not attempt the legacy API URL"
        assert all(row["decision"] == "aborted-file-http" for row in blocked_8787)
        evidence["file"] = {
            "schedule": schedule_result,
            "legacy8787RequestsAbortedAtRoute": len(blocked_8787),
            "legacy8787AllowedRequests": 0,
            "pageErrors": file_errors,
            "screenshot": screenshot(file_page, "m2-file-local"),
        }
        assert not file_errors, file_errors

        evidence["forbiddenApiRequests"] = forbidden_requests(["M2-http", "M2-file"])
        assert not evidence["forbiddenApiRequests"], evidence["forbiddenApiRequests"]
        evidence["httpNetworkRequestCount"] = len(requests_for("M2-http"))
        evidence["fileNetworkRequestCount"] = len(requests_for("M2-file"))
        evidence["serverOrigin"] = server_origin
        record("M2", "pass", True, evidence)
    except Exception as exc:
        evidence["forbiddenApiRequests"] = forbidden_requests(["M2-http", "M2-file"])
        record("M2", "fail", False, evidence, exc)
    finally:
        if file_context:
            file_context.close()
        if http_context:
            http_context.close()


def task_title(page, task_id: str = "t1") -> str:
    return page.evaluate(
        "id => (ZX.state.tasks.find(task => task.id === id) || {}).title || ''", task_id
    )


def run_m4(browser, server_origin: str) -> None:
    evidence = {}
    context = None
    try:
        context = new_context(browser, server_origin, file_mode=False, gl3d=False)
        page, errors = open_page(context, "M4", server_origin + "/")
        original_title = task_title(page)
        quota_title = f"M4 配额失败验证 {datetime.now().strftime('%H%M%S')}"
        quota = page.evaluate("""title => {
          window.__originalSetItem = Storage.prototype.setItem;
          window.__quotaThrows = 0;
          Storage.prototype.setItem = function(key, value) {
            if (key === 'zx.overlay') {
              window.__quotaThrows += 1;
              throw new DOMException('synthetic quota exceeded', 'QuotaExceededError');
            }
            return window.__originalSetItem.call(this, key, value);
          };
          const task = ZX.state.tasks.find(item => item.id === 't1');
          task.title = title;
          ZX.render();
          const raw = localStorage.getItem('zx.overlay');
          return {
            memoryTitle: task.title,
            storedTitle: raw ? (JSON.parse(raw).tasks.find(item => item.id === 't1') || {}).title : null,
            quotaThrows: window.__quotaThrows,
            saveFailed: ZX.state.overlaySaveFailed,
            warningHidden: document.querySelector('#saveWarning').hidden,
            warningText: document.querySelector('#saveWarning').textContent
          };
        }""", quota_title)
        assert quota["saveFailed"] is True and quota["quotaThrows"] > 0, quota
        assert quota["warningHidden"] is False, quota
        assert quota["warningText"] == "本机保存失败，当前修改可能在刷新后丢失。", quota
        page.locator("#saveWarning").wait_for(state="visible")
        evidence["quotaFailure"] = quota
        evidence["quotaFailureScreenshot"] = screenshot(page, "m4-quota-warning")

        restored = page.evaluate("""() => {
          Storage.prototype.setItem = window.__originalSetItem;
          ZX.render();
          const overlay = JSON.parse(localStorage.getItem('zx.overlay'));
          return {
            quotaThrows: window.__quotaThrows,
            saveFailed: ZX.state.overlaySaveFailed,
            warningHidden: document.querySelector('#saveWarning').hidden,
            overlayFormat: overlay.format,
            overlayVersion: overlay.version,
            overlaySyncMode: overlay.syncMode,
            storedTitle: overlay.tasks.find(item => item.id === 't1').title
          };
        }""")
        assert restored["saveFailed"] is False and restored["warningHidden"] is True, restored
        assert restored["storedTitle"] == quota_title
        assert restored["overlayFormat"] == "nova-overlay" and restored["overlayVersion"] == 3
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("window.ZX && ZX.state && ZX.engine", timeout=20000)
        assert task_title(page) == quota_title, "quota-period modification did not survive reload"
        evidence["quotaRecovery"] = restored
        evidence["reloadRetainedTitle"] = task_title(page)
        evidence["reloadScreenshot"] = screenshot(page, "m4-reload-retained")

        page.locator("#rail button[data-tab='me']").click()
        fold = page.locator("#view [data-act='fold'][data-key='me:data']")
        if fold.get_attribute("aria-expanded") != "true":
            fold.click()
        backup_path = OUT_DIR / "m4-nova-backup.json"
        with page.expect_download(timeout=15000) as download_info:
            page.locator("#view [data-act='export-backup']").click()
        download = download_info.value
        download.save_as(str(backup_path))
        backup_bytes = backup_path.read_bytes()
        backup = json.loads(backup_bytes.decode("utf-8-sig"))
        assert backup["format"] == "nova-backup" and backup["version"] == 1
        assert isinstance(backup["snapshot"]["tasks"], list) and backup["snapshot"]["tasks"]
        assert not ({"token", "opQueue", "op_queue", "queue"} & set(backup["snapshot"]))
        overlay = page.evaluate("JSON.parse(localStorage.getItem('zx.overlay'))")
        assert overlay["format"] == "nova-overlay" and overlay["version"] == 3
        evidence["backupExport"] = {
            "path": artifact(backup_path),
            "suggestedFilename": download.suggested_filename,
            "sha256": hashlib.sha256(backup_bytes).hexdigest(),
            "bytes": len(backup_bytes),
            "format": backup["format"],
            "version": backup["version"],
            "taskCount": len(backup["snapshot"]["tasks"]),
            "overlayFormat": overlay["format"],
            "overlayVersion": overlay["version"],
            "overlaySyncMode": overlay["syncMode"],
        }

        post_export_title = "M4 导出后修改，不应在导入后保留"
        page.evaluate("""title => {
          ZX.state.tasks.find(item => item.id === 't1').title = title;
          ZX.render();
        }""", post_export_title)
        assert task_title(page) == post_export_title
        page.locator("#backupFileInput").set_input_files(str(backup_path))
        dialog = page.locator(".ovl[role='dialog']")
        dialog.wait_for(state="visible", timeout=10000)
        assert "导入完整备份？" in dialog.inner_text()
        evidence["importConfirmationText"] = dialog.inner_text()
        dialog.locator("[data-yes]").click()
        page.wait_for_function(
            "title => (ZX.state.tasks.find(task => task.id === 't1') || {}).title === title",
            arg=quota_title,
            timeout=10000,
        )
        page.wait_for_function("!document.querySelector('.ovl[role=\"dialog\"]')", timeout=10000)
        imported_overlay_title = page.evaluate(
            "JSON.parse(localStorage.getItem('zx.overlay')).tasks.find(task => task.id === 't1').title"
        )
        assert imported_overlay_title == quota_title
        page.evaluate("ZX.render()")
        evidence["backupImport"] = {
            "beforeImportTitle": post_export_title,
            "backupTitle": quota_title,
            "afterImportTitle": task_title(page),
            "persistedTitle": imported_overlay_title,
            "confirmationAccepted": True,
        }
        evidence["importScreenshot"] = screenshot(page, "m4-import-restored")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("window.ZX && ZX.state && ZX.engine", timeout=20000)
        assert task_title(page) == quota_title, "imported task did not survive reload"
        evidence["importReloadRetainedTitle"] = task_title(page)
        evidence["pageErrors"] = errors
        assert not errors, errors
        record("M4", "pass", True, evidence)
    except Exception as exc:
        record("M4", "fail", False, evidence, exc)
    finally:
        if context:
            context.close()


def run_s1(browser, server_origin: str) -> None:
    evidence = {"variants": [], "note": "hidden GL stage must not add a second rAF loop or clone DOM while display:none"}
    try:
        for requested in (True, False):
            label = f"S1-gl3d-{'true' if requested else 'false'}"
            context = new_context(
                browser, server_origin, file_mode=False, gl3d=requested, measure=True
            )
            try:
                page, errors = open_page(context, label, server_origin + "/", settle=0)
                metrics = page.evaluate("""() => new Promise(resolve => {
                  const m = window.__acceptanceMetrics;
                  m.rafCallbacks = 0;
                  m.cloneNodeCalls = 0;
                  const start = performance.now();
                  let measurementRaf = 0;
                  function step(ts) {
                    measurementRaf += 1;
                    if (ts - start >= 2000) {
                      m.measuring = false;
                      resolve({
                        durationMs: ts - start,
                        requestAnimationFrameCallbacks: m.rafCallbacks,
                        cloneNodeCalls: m.cloneNodeCalls,
                        measurementLoopCallbacks: measurementRaf,
                        requestedGl3d: document.documentElement.dataset.gl3d,
                        injectedPrefs: JSON.parse(localStorage.getItem('zx.ui_prefs')),
                        visibilityState: document.visibilityState
                      });
                      return;
                    }
                    requestAnimationFrame(step);
                  }
                  m.measuring = true;
                  requestAnimationFrame(step);
                })""")
                metrics["gl3dRequested"] = requested
                metrics["actualGl3d"] = page.evaluate("document.documentElement.dataset.gl3d")
                # The acceptance measurement loop is wrapped by the same counter;
                # subtract its exact callback count so scheduling jitter is not
                # misattributed to the application's hidden GL stage.
                metrics["applicationRafCallbacks"] = max(
                    0, metrics["requestAnimationFrameCallbacks"] - metrics["measurementLoopCallbacks"]
                )
                metrics["rafPerSecond"] = round(
                    metrics["applicationRafCallbacks"] * 1000 / metrics["durationMs"], 2
                )
                if requested:
                    metrics["visibilityRecovery"] = page.evaluate("""() => new Promise(async resolve => {
                      const gl = document.getElementById('gl');
                      const css3d = document.getElementById('css3d');
                      const m = window.__acceptanceMetrics;
                      m.rafCallbacks = 0;
                      m.cloneNodeCalls = 0;
                      m.measuring = true;
                      gl.style.display = 'block';
                      css3d.style.display = 'block';
                      window.dispatchEvent(new Event('resize'));
                      await new Promise(r => setTimeout(r, 800));
                      m.measuring = false;
                      const visible = {
                        display: getComputedStyle(gl).display,
                        applicationRafCallbacks: m.rafCallbacks,
                        cloneNodeCalls: m.cloneNodeCalls
                      };
                      gl.style.display = 'none';
                      css3d.style.display = 'none';
                      window.dispatchEvent(new Event('resize'));
                      await new Promise(r => setTimeout(r, 100));
                      m.rafCallbacks = 0;
                      m.measuring = true;
                      await new Promise(r => setTimeout(r, 300));
                      m.measuring = false;
                      resolve({visible, hiddenApplicationRafCallbacks: m.rafCallbacks});
                    })""")
                metrics["pageErrors"] = errors
                metrics["screenshot"] = screenshot(page, label)
                assert metrics["actualGl3d"] == ("on" if requested else "off"), metrics
                assert metrics["durationMs"] >= 1900, metrics
                assert metrics["visibilityState"] == "visible", metrics
                assert metrics["requestAnimationFrameCallbacks"] > 0, metrics
                if requested:
                    recovery = metrics["visibilityRecovery"]
                    assert recovery["visible"]["display"] != "none", recovery
                    assert recovery["visible"]["applicationRafCallbacks"] > 0, recovery
                    assert recovery["visible"]["cloneNodeCalls"] > 0, recovery
                    assert recovery["hiddenApplicationRafCallbacks"] <= 2, recovery
                assert not errors, errors
                evidence["variants"].append(metrics)
            finally:
                context.close()
        assert len(evidence["variants"]) == 2
        enabled, disabled = evidence["variants"]
        evidence["rafDelta"] = enabled["applicationRafCallbacks"] - disabled["applicationRafCallbacks"]
        evidence["hiddenStagePaused"] = (
            enabled["cloneNodeCalls"] == 0
            and disabled["cloneNodeCalls"] == 0
            and max(enabled["applicationRafCallbacks"], disabled["applicationRafCallbacks"]) <= 10
            and abs(evidence["rafDelta"]) <= 10
        )
        assert evidence["hiddenStagePaused"], evidence
        record("S1", "pass", True, evidence)
    except Exception as exc:
        record("S1", "fail", False, evidence, exc)


def run_optional_7(browser, server_origin: str) -> None:
    evidence = {}
    context = None
    try:
        context = new_context(browser, server_origin, file_mode=False, gl3d=False)
        page, errors = open_page(context, "optional-7", server_origin + "/")
        page.locator("#rail button[data-tab='today']").click()
        page.wait_for_timeout(500)
        background = page.evaluate("""() => ({
          backgroundImage: getComputedStyle(document.body).backgroundImage,
          backgroundColor: getComputedStyle(document.body).backgroundColor,
          tab: document.documentElement.dataset.tab
        })""")
        blocked = [
            row for row in requests_for("optional-7")
            if "wikimedia.org" in row["url"].lower() and row["decision"] == "aborted-external"
        ]
        allowed_wikimedia = [
            row for row in requests_for("optional-7")
            if "wikimedia.org" in row["url"].lower() and row["decision"] != "aborted-external"
        ]
        assert "gradient(" in background["backgroundImage"].lower(), background
        assert not allowed_wikimedia, allowed_wikimedia
        evidence.update({
            "computedBody": background,
            "containsLocalGradient": True,
            "wikimediaRequestsAborted": len(blocked),
            "wikimediaRequestsAllowed": len(allowed_wikimedia),
            "note": (
                "The active body rule already resolves to local gradients; "
                "any Wikimedia URL request is intercepted and aborted."
            ),
            "pageErrors": errors,
            "screenshot": screenshot(page, "optional-7-local-gradient"),
        })
        assert not errors, errors
        record("optional-7", "pass", True, evidence)
    except Exception as exc:
        record("optional-7", "fail", False, evidence, exc)
    finally:
        if context:
            context.close()


def run_optional_6(browser, server_origin: str) -> None:
    evidence = {"attempts": []}
    context = None
    try:
        context = new_context(browser, server_origin, file_mode=False, gl3d=False)
        page, errors = open_page(context, "optional-6", server_origin + "/")
        page.locator("#rail button[data-tab='plan']").click()
        page.locator("#view [data-goal-new]").click()
        page.locator("[data-sa='next']").wait_for(state="visible", timeout=10000)
        page.locator("[data-sa='next']").click()
        page.locator("[data-sa='decompose']").wait_for(state="visible", timeout=10000)
        if page.locator("[data-sa='decompose']").is_disabled():
            evidence["blockedReason"] = "default goal did not pass feasibility gate"
            record("optional-6", "blocked", None, evidence)
            return
        page.locator("[data-sa='decompose']").click()
        page.locator("#saAddT").wait_for(state="visible", timeout=10000)
        for index, title in enumerate(("M6 输入框复填验证 A", "M6 输入框复填验证 B"), start=1):
            before_count = page.evaluate("ZX.state.planDraft.length")
            page.locator("#saAddT").fill(title)
            page.locator("#saAddM").fill("60")
            page.locator("[data-sa='add']").click()
            page.wait_for_function(
                "count => ZX.state.planDraft.length === count + 1", arg=before_count
            )
            observed = page.evaluate("""() => ({
              inputValue: document.querySelector('#saAddT').value,
              minuteValue: document.querySelector('#saAddM').value,
              addedTitle: ZX.state.planDraft[ZX.state.planDraft.length - 1].title,
              matchingTitleCount: ZX.state.planDraft.filter(item => item.title === document.querySelector('#saAddT').value).length,
              planLength: ZX.state.planDraft.length
            })""")
            observed["attempt"] = index
            observed["expectedInputValue"] = ""
            observed["expectedTitle"] = title
            observed["refilledWithOldValue"] = observed["inputValue"] == title
            evidence["attempts"].append(observed)
            if index == 1:
                evidence["screenshot"] = screenshot(page, "optional-6-add-item-refill")
        reproduced = all(item["refilledWithOldValue"] for item in evidence["attempts"])
        fixed = len(evidence["attempts"]) == 2 and all(
            item["inputValue"] == "" and item["addedTitle"] == item["expectedTitle"]
            for item in evidence["attempts"]
        )
        evidence["realDomFlow"] = "计划 → 新建目标 → 可行性 → 拆解 → 填写并点击添加计划项"
        evidence["pageErrors"] = errors
        evidence["stableReproduction"] = reproduced and len(evidence["attempts"]) == 2
        assert not errors, errors
        if fixed:
            evidence["note"] = "Two real DOM add-item attempts kept the title input empty."
            record("optional-6", "pass", True, evidence)
        elif reproduced:
            record("optional-6", "reproduced", False, evidence)
        else:
            evidence["note"] = "No old-value refill, but the input was not empty as expected."
            record("optional-6", "fail", False, evidence)
    except Exception as exc:
        if evidence.get("blockedReason"):
            record("optional-6", "blocked", None, evidence, exc)
        else:
            record("optional-6", "blocked", None, evidence, exc)
    finally:
        if context:
            context.close()


def run_optional_a4(browser, server_origin: str) -> None:
    evidence = {}
    context = None
    label = "optional-a4"
    try:
        context = new_context(browser, server_origin, file_mode=False, gl3d=False)
        page, errors = open_page(context, label + "-veto", server_origin + "/")
        page.evaluate("""() => {
          const S = ZX.state;
          S.tasks = [S.normTask({ id: 'a4-veto', title: 'A4 否决任务', subject: '数学', est: 60, weight: 0.8 })];
          S.placementModel = null;
          S.week = [{ d: '日', total: 35, buf: 0, segs: [] }];
          S.dayAssign = {};
          S.locks = {};
          S.replanHistory = [];
          S.snapshot = null;
          S.replanned = false;
          S.replanRecord = null;
          ZX.engine.replan = async () => ({
            accepted: true,
            strategies: [{ level: 2, name: '压缩', applied: true, growth: 0, reason: 'A4 合成压缩' }],
            diff: [{ taskId: 'a4-veto', op: 'compress', from: 60, to: 35 }],
            guards: { loadGrowthOk: true, bufferPreserved: true, compressedShareOk: true }
          });
          ZX.render();
        }""")
        page.evaluate("ZX.flows.replan.replanFlow()")
        page.locator("#rail button[data-tab='chat']").click()
        page.locator("[data-act='confirm-replan']").last.wait_for(state="visible", timeout=10000)
        page.locator("[data-act='confirm-replan']").last.click()
        veto = page.locator("[data-veto='a4-veto'][data-vop='compress']").last
        veto.wait_for(state="visible", timeout=10000)
        evidence["vetoDraftBound"] = "data-vdraft" in veto.evaluate("el => el.outerHTML")
        evidence["vetoPlanBound"] = "data-vplan" in veto.evaluate("el => el.outerHTML")
        veto.click()
        page.wait_for_timeout(500)
        evidence["postVetoClick"] = page.evaluate("""() => ({
          est: ZX.state.tasks.find(task => task.id === 'a4-veto')?.est,
          saveFailed: ZX.state.overlaySaveFailed,
          conflict: ZX.state.overlayConflict,
          vetoed: ZX.state.replanRecord?.vetoed || [],
          toast: document.querySelector('.toast')?.textContent || ''
        })""")
        page.wait_for_function("ZX.state.tasks.find(task => task.id === 'a4-veto').est === 60")
        evidence["vetoRestoredEst"] = page.evaluate("ZX.state.tasks.find(task => task.id === 'a4-veto').est")
        evidence["vetoMarked"] = page.locator(".sc2-diff.is-vetoed").count() > 0
        evidence["vetoScreenshot"] = screenshot(page, "optional-a4-veto")
        assert evidence["vetoDraftBound"] and evidence["vetoPlanBound"]
        assert evidence["vetoRestoredEst"] == 60 and evidence["vetoMarked"]
        assert not errors, errors
        context.close()
        context = None

        context = new_context(browser, server_origin, file_mode=False, gl3d=False)
        page, errors = open_page(context, label + "-retry", server_origin + "/")
        context.route("**/api/llm/clarify", lambda route: route.fulfill(status=200, json={
            "reply": "画像已确认", "done": True, "missing": [],
            "profile": {"goalType": "考研", "goalName": "A4 澄清目标", "deadline": "2027-12-25", "weeklyH": 10, "level": "一轮", "subjects": ["数学"]}
        }))
        context.route("**/api/llm/analyze", lambda route: route.fulfill(status=200, json={
            "summary": "A4 合成建议", "demandH": 500, "weeklyH": 10,
            "tasks": [{"s": "数学", "title": "A4 重试任务", "est": 60, "weight": 0.9}],
            "risks": [], "advice": ""
        }))
        page.evaluate("ZX.flows.clarify.start('我要定一个学习目标')")
        page.locator("[data-cl='build']").wait_for(state="visible", timeout=10000)
        page.locator("[data-cl='build']").click()
        page.locator("[data-cl='apply']").wait_for(state="visible", timeout=10000)
        page.evaluate("() => { window.__a4OriginalSchedule = ZX.engine.schedule; ZX.engine.schedule = async () => { throw new Error('A4 synthetic schedule failure'); }; return true; }")
        page.locator("[data-cl='apply']").click()
        retry = page.locator("[data-cl='retry-apply']")
        retry.wait_for(state="visible", timeout=10000)
        evidence["retryKeepsSession"] = page.evaluate("ZX.flows.clarify.active()")
        evidence["retryKeepsDraft"] = page.evaluate("ZX.state.goalDraft?.source === 'clarify' && ZX.state.planDraft?.length === 1")
        evidence["retryPlanBound"] = "data-cl-plan" in retry.evaluate("el => el.outerHTML")
        evidence["retryScreenshot"] = screenshot(page, "optional-a4-retry")
        page.evaluate("() => { ZX.engine.schedule = window.__a4OriginalSchedule; return true; }")
        retry.click()
        page.wait_for_function("ZX.state.goal?.source === 'user' && !ZX.flows.clarify.active()", timeout=15000)
        evidence["retryCommitted"] = page.evaluate("ZX.state.goal.name === 'A4 澄清目标'")
        evidence["pageErrors"] = errors
        assert evidence["retryKeepsSession"] and evidence["retryKeepsDraft"] and evidence["retryPlanBound"]
        assert evidence["retryCommitted"] and not errors
        record(label, "pass", True, evidence)
    except Exception as exc:
        record(label, "fail", False, evidence, exc)
    finally:
        if context:
            context.close()


def run_optional_a7(browser, server_origin: str) -> None:
    evidence = {}
    context = None
    label = "optional-a7"
    try:
        context = new_context(browser, server_origin, file_mode=False, gl3d=True)
        page, errors = open_page(context, label, server_origin + "/")
        page.evaluate("""() => {
          document.getElementById('gl').style.display = 'block';
          document.getElementById('css3d').style.display = 'block';
          window.dispatchEvent(new Event('resize'));
        }""")
        page.wait_for_function("document.documentElement.dataset.gl3d === 'on' && !!document.querySelector('.gl-stream')", timeout=15000)
        evidence["placement"] = page.evaluate("""() => {
          const P = window.Rhythm.placementModel;
          const dates = Array.from({length: 7}, (_, i) => '2026-11-' + String(23 + i).padStart(2, '0'));
          function fixture(n) {
            const tasks = [], blocks = [];
            for (let i = 0; i < n; i++) {
              const id = 'a7-' + i;
              const date = dates[i % 7];
              const startMin = 480 + Math.floor(i / 7) * 10;
              tasks.push({id, subject: '数学', estMin: 10});
              blocks.push({id: 'a7-block-' + i, taskId: id, date, startMin, durMin: 10});
            }
            return P.createModel({startDate: dates[0], timezone: 'UTC', idPrefix: 'a7_', tasks, blocks,
              slots: dates.map(date => ({date, startMin: 480, durMin: 960, isBuffer: false})), unplanned: []});
          }
          return [100, 500].map(n => {
            const model = fixture(n);
            const ids = model.placements.map(item => item.taskId);
            const legacyStart = performance.now();
            let legacyCount = 0;
            for (const id of ids) legacyCount += P.taskSegments(model, id).length;
            const legacyMs = performance.now() - legacyStart;
            const mapStart = performance.now();
            const map = P.taskSegmentsMap(model);
            const mapCount = ids.reduce((sum, id) => sum + (map[id] || []).length, 0);
            const mapMs = performance.now() - mapStart;
            return {tasks: n, legacyCount, mapCount, legacyMs: +legacyMs.toFixed(3), mapMs: +mapMs.toFixed(3)};
          });
        }""")
        assert all(row["legacyCount"] == row["tasks"] and row["mapCount"] == row["tasks"] and row["mapMs"] < row["legacyMs"] for row in evidence["placement"])

        page.wait_for_timeout(700)
        page.evaluate("document.getElementById('chat').replaceChildren()")
        page.wait_for_timeout(50)
        evidence["longChat"] = page.evaluate("""async () => {
          const chat = document.getElementById('chat');
          const proto = Element.prototype;
          const htmlDescriptor = Object.getOwnPropertyDescriptor(proto, 'outerHTML');
          const nativeClone = proto.cloneNode;
          let cloneCalls = 0, htmlReads = 0;
          proto.cloneNode = function (...args) { cloneCalls++; return nativeClone.apply(this, args); };
          Object.defineProperty(proto, 'outerHTML', {configurable: true, get() { htmlReads++; return htmlDescriptor.get.call(this); }});
          const start = performance.now();
          for (let i = 0; i < 200; i++) {
            const node = document.createElement('div');
            node.className = 'msg';
            node.textContent = 'A7 长对话 ' + i;
            chat.appendChild(node);
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          await new Promise(resolve => setTimeout(resolve, 50));
          const ms = performance.now() - start;
          proto.cloneNode = nativeClone;
          Object.defineProperty(proto, 'outerHTML', htmlDescriptor);
          return {messages: 200, cloneCalls, htmlReads, ms: +ms.toFixed(3), streamChildren: document.querySelector('.gl-stream').children.length};
        }""")
        assert evidence["longChat"]["streamChildren"] == 200
        assert evidence["longChat"]["cloneCalls"] <= 220
        assert evidence["longChat"]["htmlReads"] <= 1000
        assert evidence["longChat"]["ms"] <= 5000
        evidence["screenshot"] = screenshot(page, "optional-a7-long-chat")
        evidence["pageErrors"] = errors
        assert not errors, errors
        record(label, "pass", True, evidence)
    except Exception as exc:
        record(label, "fail", False, evidence, exc)
    finally:
        if context:
            context.close()


def run_optional_a8(browser, server_origin: str) -> None:
    evidence = {}
    context = None
    label = "optional-a8"
    try:
        context = new_context(browser, server_origin, file_mode=False, gl3d=False)
        first, first_errors = open_page(context, label + "-race-a", server_origin + "/")
        first.evaluate("""() => {
          const S = ZX.state;
          S.tasks = [S.normTask({id: 'a8-race', title: '同时写基线', subject: '数学', est: 60, weight: 0.8})];
          S.placementModel = null;
          S.week = [{d: '日', total: 60, buf: 0, segs: []}];
          S.dayAssign = {};
          S.locks = {};
          S.replanHistory = [];
          S.snapshot = null;
          S.replanned = false;
          ZX.render();
        }""")
        first.wait_for_function("JSON.parse(localStorage.getItem('zx.overlay')).tasks[0].title === '同时写基线'")
        second, second_errors = open_page(context, label + "-race-b", server_origin + "/")
        for page, title in ((first, '同时写 A'), (second, '同时写 B')):
            page.evaluate("""title => {
              ZX.state.tasks[0].title = title;
              window.__a8Channel = new BroadcastChannel('nova-a8-race');
              window.__a8Go = new Promise(resolve => { window.__a8Channel.onmessage = () => resolve(); });
              window.__a8Save = window.__a8Go.then(() => ZX.state.saveOverlay());
            }""", title)
        first.evaluate("() => { const channel = new BroadcastChannel('nova-a8-race'); channel.postMessage('go'); channel.close(); }")
        result_a = first.evaluate("window.__a8Save")
        result_b = second.evaluate("window.__a8Save")
        stored_title = first.evaluate("JSON.parse(localStorage.getItem('zx.overlay')).tasks[0].title")
        evidence["simultaneousSave"] = {
          "results": [result_a, result_b], "storedTitle": stored_title,
          "loserConflict": (second if not result_b else first).evaluate("ZX.state.overlayConflict"),
          "atomicProtectionHeld": sorted([result_a, result_b]) == [False, True],
          "lostUpdateObserved": result_a and result_b,
          "pageErrors": first_errors + second_errors
        }
        assert stored_title in ("同时写 A", "同时写 B"), evidence["simultaneousSave"]
        assert not first_errors and not second_errors
        context.close()
        context = None

        context = new_context(browser, server_origin, file_mode=True, gl3d=False)
        file_page, file_errors = open_page(context, label + "-file", FILE_URL)
        file_page.locator("#rail button[data-tab='today']").click()
        before_sessions = file_page.evaluate("ZX.state.sessions.length")
        file_page.locator("[data-act='start']").first.wait_for(state="visible", timeout=10000)
        file_page.locator("[data-act='start']").first.click()
        evidence["fileStartClicked"] = True
        file_page.wait_for_function("!!ZX.state.running", timeout=10000)
        file_page.locator("[data-act='finish']").first.wait_for(state="visible", timeout=10000)
        file_page.locator("[data-act='finish']").first.click()
        file_page.locator("[data-sc='save-record']").wait_for(state="visible", timeout=10000)
        file_page.locator("[data-sc='save-record']").click()
        evidence["fileFinishClicked"] = True
        file_page.wait_for_function("count => ZX.state.sessions.length === count + 1", arg=before_sessions, timeout=10000)
        file_page.locator("#rail button[data-tab='me']").click()
        data_fold = file_page.locator("#view [data-act='fold'][data-key='me:data']")
        if data_fold.get_attribute("aria-expanded") != "true":
            data_fold.click()
        backup_path = OUT_DIR / "a8-file-backup.json"
        with file_page.expect_download(timeout=15000) as download_info:
            file_page.locator("#view [data-act='export-backup']").click()
        download_info.value.save_as(str(backup_path))
        file_page.evaluate("ZX.state.tasks[0].title = 'file 导入前修改'; ZX.render()")
        file_page.locator("#backupFileInput").set_input_files(str(backup_path))
        dialog = file_page.locator(".ovl[role='dialog']")
        dialog.wait_for(state="visible", timeout=10000)
        dialog.locator("[data-yes]").click()
        file_page.wait_for_function("ZX.state.tasks[0].title !== 'file 导入前修改'", timeout=10000)
        file_page.wait_for_function("!document.querySelector('.ovl[role=\"dialog\"]')", timeout=10000)
        file_page.reload(wait_until="domcontentloaded")
        file_page.wait_for_function("window.ZX && ZX.state && ZX.engine", timeout=20000)
        assert file_page.evaluate("ZX.state.sessions.length") == before_sessions + 1
        evidence["fileExecutionAndBackup"] = {
          "sessionsBefore": before_sessions,
          "sessionsAfterReload": file_page.evaluate("ZX.state.sessions.length"),
          "backup": artifact(backup_path),
          "pageErrors": file_errors
        }
        assert not file_errors
        context.close()
        context = None

        context = new_context(browser, server_origin, file_mode=False, gl3d=False)
        gate_page, gate_errors = open_page(context, label + "-gates", server_origin + "/")
        console_errors = []
        bad_responses = []
        gate_page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        gate_page.on("response", lambda response: bad_responses.append({"status": response.status, "url": response.url}) if response.status >= 400 else None)
        for tab in ("today", "plan", "data", "me", "chat"):
            gate_page.locator(f"#rail button[data-tab='{tab}']").click()
            gate_page.wait_for_function("tab => document.documentElement.dataset.tab === tab", arg=tab)
        gate_page.wait_for_timeout(500)
        evidence["consoleAnd404Gates"] = {
          "consoleErrors": console_errors, "httpErrors": bad_responses, "pageErrors": gate_errors
        }
        assert not console_errors and not bad_responses and not gate_errors
        evidence["screenshot"] = screenshot(gate_page, "optional-a8-gates")
        record(label, "pass", True, evidence)
    except Exception as exc:
        record(label, "fail", False, evidence, exc)
    finally:
        if context:
            context.close()


def run_optional_concurrency(browser, server_origin: str) -> None:
    evidence = {}
    context = None
    label = "optional-concurrency"
    try:
        context = new_context(browser, server_origin, file_mode=False, gl3d=False)
        first, first_errors = open_page(context, label + "-a", server_origin + "/")
        second = context.new_page()
        second_errors = []
        second.on("pageerror", lambda error: second_errors.append(str(error)))
        second.goto(server_origin + "/", wait_until="domcontentloaded")
        second.wait_for_function("() => !!window.ZX?.state?.saveOverlay", timeout=15000)

        first.evaluate("""() => {
          const S = ZX.state;
          S.tasks = [S.normTask({ id: 'concurrency-task', title: '标签页 A 已保存', subject: '数学', est: 60, weight: 0.8 })];
          S.placementModel = null;
          S.dayAssign = {};
          S.locks = {};
          S.replanHistory = [];
          S.snapshot = null;
          S.replanned = false;
          ZX.render();
        }""")
        first.wait_for_function("() => JSON.parse(localStorage.getItem('zx.overlay')).tasks[0].title === '标签页 A 已保存'")
        second.wait_for_function("() => ZX.state.overlayConflict === true", timeout=10000)

        stale = second.evaluate("""() => {
          ZX.state.tasks[0].title = '标签页 B 未保存修改';
          const saved = ZX.state.saveOverlay();
          const dropped = ZX.state.dropOverlay();
          return {
            saved, dropped, localTitle: ZX.state.tasks[0].title,
            conflict: ZX.state.overlayConflict,
            saveFailed: ZX.state.overlaySaveFailed,
            warning: document.querySelector('#saveWarning')?.textContent || ''
          };
        }""")
        persisted = first.evaluate("""() => {
          const overlay = JSON.parse(localStorage.getItem('zx.overlay'));
          return { title: overlay.tasks[0].title, revision: overlay.revision };
        }""")
        assert stale["saved"] is False and stale["dropped"] is False, stale
        assert stale["conflict"] is True and stale["saveFailed"] is True, stale
        assert persisted["title"] == "标签页 A 已保存", persisted
        assert "另一标签页" in stale["warning"], stale
        evidence["stalePage"] = stale
        evidence["persistedAfterRejectedSaveAndDelete"] = persisted
        evidence["screenshot"] = screenshot(second, "optional-concurrency-conflict")

        second.reload(wait_until="domcontentloaded")
        second.wait_for_function("() => !!window.ZX?.state && ZX.state.overlayConflict === false", timeout=15000)
        recovered = second.evaluate("""() => ({
          title: ZX.state.tasks[0].title,
          conflict: ZX.state.overlayConflict,
          saveFailed: ZX.state.overlaySaveFailed
        })""")
        assert recovered["title"] == "标签页 A 已保存" and recovered["conflict"] is False, recovered
        evidence["afterReload"] = recovered

        backup_text = first.evaluate("() => JSON.stringify(ZX.settings.exportBackup())")
        external_raw = first.evaluate("""() => {
          ZX.state.tasks[0].title = '导入期间另一页写入';
          ZX.render();
          return localStorage.getItem('zx.overlay');
        }""")
        baseline_raw = first.evaluate("""() => {
          ZX.state.tasks[0].title = '标签页 A 已保存';
          ZX.render();
          return localStorage.getItem('zx.overlay');
        }""")
        external = json.loads(external_raw)
        external["revision"] = json.loads(baseline_raw)["revision"] + 10
        external_raw = json.dumps(external, ensure_ascii=False, separators=(",", ":"))
        second.reload(wait_until="domcontentloaded")
        second.wait_for_function("() => !!window.ZX?.state && ZX.state.overlayConflict === false", timeout=15000)
        failed_import = second.evaluate("""async ([backup, external]) => {
          ZX.ui.confirm = async () => true;
          const nativeReload = ZX.state.applyOverlay;
          let reloadCalls = 0;
          ZX.state.applyOverlay = function () {
            if (reloadCalls++ === 0) {
              localStorage.setItem('zx.overlay', external);
              return false;
            }
            return nativeReload();
          };
          const ok = await ZX.settings.importBackup(backup);
          return {
            ok,
            memoryTitle: ZX.state.tasks[0].title,
            storedTitle: JSON.parse(localStorage.getItem('zx.overlay')).tasks[0].title,
            trash: localStorage.getItem('zx.trash')
          };
        }""", [backup_text, external_raw])
        assert failed_import["ok"] is False, failed_import
        assert failed_import["memoryTitle"] == "导入期间另一页写入", failed_import
        assert failed_import["storedTitle"] == "导入期间另一页写入", failed_import
        assert failed_import["trash"] is None, failed_import
        evidence["failedImportPreservedExternalWrite"] = failed_import

        second.evaluate("() => localStorage.setItem('zx.overlay', '{synthetic-corrupt')")
        second.reload(wait_until="domcontentloaded")
        second.wait_for_function("() => !!window.ZX?.state && ZX.state.localLoadFailed === true", timeout=15000)
        corrupt_delete = second.evaluate("""async () => {
          ZX.ui.confirm = async () => true;
          await ZX.settings.confirmWipe();
          return {
            overlay: localStorage.getItem('zx.overlay'),
            trash: localStorage.getItem('zx.trash'),
            webLocksAvailable: !!navigator.locks
          };
        }""")
        assert corrupt_delete["overlay"] is None, corrupt_delete
        assert corrupt_delete["trash"] is not None, corrupt_delete
        evidence["explicitDeleteOfCorruptOverlay"] = {
            "overlayRemoved": corrupt_delete["overlay"] is None,
            "trashCreated": corrupt_delete["trash"] is not None,
            "webLocksAvailable": corrupt_delete["webLocksAvailable"]
        }

        second.reload(wait_until="domcontentloaded")
        second.wait_for_function("() => !!window.ZX?.settings?.restore", timeout=15000)
        second.evaluate("() => localStorage.setItem('zx.trash', JSON.stringify({ at: Date.now(), snapshot: ZX.state.exportSnapshot() }))")
        external_trash = json.dumps({"at": int(time.time() * 1000) + 60000, "snapshot": {"external": "保留"}}, ensure_ascii=False)
        restored_trash = second.evaluate("""async external => {
          window.__restoreNotices = [];
          const nativeToast = ZX.ui.toast;
          ZX.ui.toast = message => { window.__restoreNotices.push(message); return nativeToast(message); };
          const nativeSave = ZX.state.saveOverlay;
          let injected = false;
          ZX.state.saveOverlay = function () {
            const saved = nativeSave();
            if (!injected) {
              injected = true;
              localStorage.setItem('zx.trash', external);
            }
            return saved;
          };
          const ok = await ZX.settings.restore();
          return {
            ok, trash: localStorage.getItem('zx.trash'), notices: window.__restoreNotices,
            saveFailed: ZX.state.overlaySaveFailed, localLoadFailed: ZX.state.localLoadFailed,
            conflict: ZX.state.overlayConflict
          };
        }""", external_trash)
        assert restored_trash["ok"] is True, restored_trash
        assert restored_trash["trash"] == external_trash, restored_trash
        evidence["restorePreservedExternalTrash"] = restored_trash
        evidence["pageErrors"] = first_errors + second_errors
        evidence["forbiddenApiRequests"] = forbidden_requests([label + "-a", label + "-b"])
        assert not evidence["pageErrors"], evidence["pageErrors"]
        assert not evidence["forbiddenApiRequests"], evidence["forbiddenApiRequests"]
        record(label, "pass", True, evidence)
    except Exception as exc:
        evidence["pageErrors"] = locals().get("first_errors", []) + locals().get("second_errors", [])
        evidence["forbiddenApiRequests"] = forbidden_requests([label + "-a", label + "-b"])
        failure_screenshot(locals().get("second"), label, evidence)
        record(label, "fail", False, evidence, exc)
    finally:
        if context:
            context.close()


def run_optional_a11y(browser, server_origin: str) -> None:
    evidence = {}
    context = None
    label = "optional-a11y"
    try:
        context = new_context(browser, server_origin, file_mode=False, gl3d=False)
        page, errors = open_page(context, label, server_origin + "/")
        semantics = page.evaluate("""() => {
          const named = el => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.innerText || el.title || '').trim();
          const controls = [...document.querySelectorAll('button, input, select, textarea, [role="button"]')]
            .filter(el => !el.hidden && el.getAttribute('aria-hidden') !== 'true' && el.getAttribute('type') !== 'hidden');
          return {
            htmlLang: document.documentElement.lang,
            title: document.title,
            unnamedControls: controls.filter(el => !named(el)).map(el => el.outerHTML.slice(0, 240)),
            controlCount: controls.length,
            navigationCount: document.querySelectorAll('nav, [role="navigation"]').length,
            mainCount: document.querySelectorAll('main, [role="main"]').length
          };
        }""")
        assert semantics["htmlLang"] and semantics["title"], semantics
        assert semantics["controlCount"] > 0 and semantics["navigationCount"] > 0, semantics
        assert semantics["mainCount"] > 0, semantics
        assert not semantics["unnamedControls"], semantics
        evidence["semantics"] = semantics
        evidence["bodyAriaExcerpt"] = page.locator("body").aria_snapshot()[:4000]

        views = {}
        for tab in ("today", "plan", "data", "me"):
            page.locator(f"#rail button[data-tab='{tab}']").click()
            page.wait_for_function("tab => document.documentElement.dataset.tab === tab", arg=tab)
            text = page.locator("#view").inner_text().strip()
            assert text, tab
            views[tab] = {"characters": len(text), "headingOrTextExcerpt": text[:160]}
        evidence["views"] = views

        page.locator("#rail button[data-tab='plan']").click()
        page.locator("#view [data-goal-new]").click()
        dialog = page.locator(".ovl[role='dialog']").last
        dialog.wait_for(state="visible", timeout=10000)
        dialog_snapshot = dialog.aria_snapshot()
        assert dialog_snapshot.strip(), "dialog accessibility tree is empty"
        evidence["dialogAriaExcerpt"] = dialog_snapshot[:4000]
        evidence["screenshot"] = screenshot(page, "optional-a11y-goal-dialog")
        page.keyboard.press("Escape")
        evidence["pageErrors"] = errors
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        assert not errors, errors
        assert not evidence["forbiddenApiRequests"], evidence["forbiddenApiRequests"]
        record(label, "pass", True, evidence)
    except Exception as exc:
        evidence["pageErrors"] = locals().get("errors", [])
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        failure_screenshot(locals().get("page"), label, evidence)
        record(label, "fail", False, evidence, exc)
    finally:
        if context:
            context.close()


def run_optional_mobile(browser, server_origin: str) -> None:
    evidence = {}
    context = None
    label = "optional-mobile"
    try:
        context = new_context(
            browser, server_origin, file_mode=False, gl3d=False,
            viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True
        )
        page, errors = open_page(context, label, server_origin + "/")

        def tap(locator):
            box = locator.bounding_box()
            assert box, "touch target is not visible"
            page.touchscreen.tap(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)

        views = {}
        for tab in ("today", "plan", "data", "me"):
            tap(page.locator(f"#rail button[data-tab='{tab}']"))
            page.wait_for_function("tab => document.documentElement.dataset.tab === tab", arg=tab)
            metrics = page.evaluate("""() => {
              const rail = document.querySelector('#rail');
              const buttons = [...document.querySelectorAll('#rail button[data-tab]')];
              return {
                viewport: [innerWidth, innerHeight],
                scrollWidth: document.documentElement.scrollWidth,
                viewCharacters: document.querySelector('#view')?.innerText.trim().length || 0,
                minRailTargetHeight: Math.min(...buttons.map(button => button.getBoundingClientRect().height)),
                railBottom: rail?.getBoundingClientRect().bottom || 0
              };
            }""")
            assert metrics["scrollWidth"] <= metrics["viewport"][0] + 1, metrics
            assert metrics["viewCharacters"] > 0, metrics
            assert metrics["minRailTargetHeight"] >= 40, metrics
            views[tab] = metrics
        evidence["touchViews"] = views
        evidence["screenshot"] = screenshot(page, "optional-mobile-me")

        tap(page.locator("#rail button[data-tab='plan']"))
        tap(page.locator("#view [data-goal-new]"))
        dialog = page.locator(".ovl[role='dialog']").last
        dialog.wait_for(state="visible", timeout=10000)
        dialog_metrics = page.evaluate("""() => {
          const rect = document.querySelector(".ovl[role='dialog']").getBoundingClientRect();
          return {
            left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
            viewport: [innerWidth, innerHeight],
            text: document.querySelector(".ovl[role='dialog']").innerText.trim().length
          };
        }""")
        assert dialog_metrics["left"] >= -1 and dialog_metrics["right"] <= dialog_metrics["viewport"][0] + 1, dialog_metrics
        assert dialog_metrics["top"] >= -1 and dialog_metrics["bottom"] <= dialog_metrics["viewport"][1] + 1, dialog_metrics
        assert dialog_metrics["text"] > 0, dialog_metrics
        evidence["dialog"] = dialog_metrics
        evidence["dialogScreenshot"] = screenshot(page, "optional-mobile-goal-dialog")
        tap(dialog.get_by_role("button", name="取消", exact=True))
        dialog.wait_for(state="hidden", timeout=10000)
        evidence["pageErrors"] = errors
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        assert not errors, errors
        assert not evidence["forbiddenApiRequests"], evidence["forbiddenApiRequests"]
        record(label, "pass", True, evidence)
    except Exception as exc:
        evidence["pageErrors"] = locals().get("errors", [])
        evidence["forbiddenApiRequests"] = forbidden_requests([label])
        failure_screenshot(locals().get("page"), label, evidence)
        record(label, "fail", False, evidence, exc)
    finally:
        if context:
            context.close()


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    proc = None
    browser = None
    playwright = None
    try:
        proc, server_origin, _, _ = start_server()
        playwright = sync_playwright().start()
        browser = playwright.chromium.launch(
            headless=True,
            args=[
                "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-default-apps",
                "--disable-sync",
                "--metrics-recording-only",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        REPORT["isolation"]["chromiumExecutable"] = playwright.chromium.executable_path
        run_m1(browser, server_origin)
        run_m2(browser, server_origin)
        run_m3(browser, server_origin)
        run_m4(browser, server_origin)
        run_s1(browser, server_origin)
        run_s2(browser, server_origin)
        run_s5(browser, server_origin)
        run_s6(browser, server_origin)
        run_s8(browser, server_origin)
        run_optional_7(browser, server_origin)
        run_optional_6(browser, server_origin)
        run_optional_concurrency(browser, server_origin)
        run_optional_a11y(browser, server_origin)
        run_optional_mobile(browser, server_origin)
        run_optional_a4(browser, server_origin)
        run_optional_a7(browser, server_origin)
        run_optional_a8(browser, server_origin)
    except Exception as exc:
        REPORT["fatalError"] = error_text(exc)
        log("fatal: " + REPORT["fatalError"])
    finally:
        if browser:
            try:
                browser.close()
            except Exception as exc:
                REPORT["browserCloseError"] = error_text(exc)
        if playwright:
            try:
                playwright.stop()
            except Exception as exc:
                REPORT["playwrightStopError"] = error_text(exc)
        stop_server(proc)
        allowed_8787 = [
            row for row in REPORT["network"]
            if urlparse(row["url"]).hostname == "127.0.0.1"
            and urlparse(row["url"]).port == 8787
            and row["decision"] != "aborted-file-http"
        ]
        aborted_8787 = [
            row for row in REPORT["network"]
            if urlparse(row["url"]).hostname == "127.0.0.1"
            and urlparse(row["url"]).port == 8787
            and row["decision"] == "aborted-file-http"
        ]
        REPORT["isolation"].update({
            "legacy8787RouteAbortCount": len(aborted_8787),
            "legacy8787AllowedCount": len(allowed_8787),
            "existing8787Used": bool(allowed_8787),
            "externalHttpAllowedCount": sum(
                1 for row in REPORT["network"]
                if row["decision"] == "allowed-acceptance-origin"
                and row["url"].startswith(("http://", "https://"))
                and REPORT.get("server", {}).get("url")
                and not row["url"].startswith(REPORT["server"]["url"])
            ),
        })
        for key in REQUIRED + OPTIONAL:
            if REPORT["checks"][key]["status"] == "pending":
                REPORT["checks"][key] = {
                    "status": "blocked",
                    "pass": None,
                    "evidence": {},
                    "error": "scenario did not execute",
                }
        write_report()
        log(f"report: {REPORT_FILE}")
    print(json.dumps({
        "outputDir": str(OUT_DIR),
        "report": str(REPORT_FILE),
        "summary": REPORT["summary"],
        "checks": REPORT["checks"],
        "fatalError": REPORT.get("fatalError"),
    }, ensure_ascii=False, indent=2))
    strict_optional = '--allow-optional-failures' not in sys.argv
    optional_ok = REPORT["summary"].get("optionalAllPass", False)
    return 0 if REPORT["summary"]["requiredAllPass"] and (optional_ok or not strict_optional) and not REPORT.get("fatalError") else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Bond device end-to-end test.

Drives the signed release APK on a connected Android device or emulator against the live
server, through the real UI (adb input + the accessibility tree), and records a pass or fail
for every step with a screenshot. Nothing is mocked.

    python3 tools/device-e2e.py path/to/Bond.apk [out_dir]

Needs adb on PATH and one device online. It uninstalls Bond first, so the run starts from a
fresh install. Money: none moves; the agent only reads a devnet balance.
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

PKG = "com.zkasuran.bond"
APK = sys.argv[1] if len(sys.argv) > 1 else "Bond.apk"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/evidence/device-e2e")
OUT.mkdir(parents=True, exist_ok=True)
results = []


def adb(*args, timeout=60):
    return subprocess.run(["adb", *args], capture_output=True, text=True, timeout=timeout).stdout


def nodes():
    xml = subprocess.run(["timeout", "30", "adb", "exec-out", "uiautomator", "dump", "/dev/tty"],
                         capture_output=True, text=True).stdout
    out = []
    for m in re.finditer(r"<node [^>]*>", xml):
        n = m.group(0)
        t = re.search(r'text="([^"]*)"', n).group(1)
        d = re.search(r'content-desc="([^"]*)"', n).group(1)
        b = tuple(map(int, re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n).groups()))
        out.append((t, d, b))
    return out


def screen_text():
    return " | ".join(x for t, d, _ in nodes() for x in (t, d) if x)


def find(pattern, tries=6):
    for _ in range(tries):
        hits = [(t, d, b) for t, d, b in nodes() if re.search(pattern, t) or re.search(pattern, d)]
        if hits:
            return hits
        time.sleep(2)
    return []


def tap(pattern, index=0):
    hits = find(pattern)
    if not hits:
        raise RuntimeError(f"not on screen: {pattern}")
    _, _, (a, b, c, e) = hits[index]
    adb("shell", "input", "tap", str((a + c) // 2), str((b + e) // 2))
    time.sleep(1.2)


def type_text(text):
    adb("shell", "input", "text", text.replace(" ", "%s"))
    time.sleep(0.6)


def hide_keyboard():
    adb("shell", "input", "keyevent", "111")
    time.sleep(0.6)


def shot(name):
    path = OUT / f"{len(results) + 1:02d}-{name}.png"
    with open(path, "wb") as f:
        f.write(subprocess.run(["adb", "exec-out", "screencap", "-p"], capture_output=True).stdout)
    return path.name


def step(name, check, wait=0.0):
    time.sleep(wait)
    try:
        ok, detail = check()
    except Exception as e:  # a step that cannot run is a failure, with the reason
        ok, detail = False, f"error: {e}"
    results.append({"step": name, "pass": bool(ok), "detail": str(detail)[:240], "screenshot": shot(name)})
    print(("PASS " if ok else "FAIL ") + name + " :: " + str(detail)[:160], flush=True)


def wait_for(pattern, seconds):
    end = time.time() + seconds
    while time.time() < end:
        txt = screen_text()
        m = re.search(pattern, txt)
        if m:
            return True, m.group(0)
        time.sleep(3)
    return False, "timed out"


def dismiss_anr():
    if find(r"^Wait$", tries=1):
        tap(r"^Wait$")


# --- run ---------------------------------------------------------------------------------------
dev = [l for l in adb("devices").splitlines()[1:] if l.strip().endswith("device")]
if len(dev) != 1:
    sys.exit("need exactly one device online")

adb("uninstall", PKG)
inst = adb("install", APK, timeout=300)
version = re.search(r"versionName=(\S+)", adb("shell", "dumpsys", "package", PKG))
adb("logcat", "-c")
adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
time.sleep(18)
dismiss_anr()

step("fresh install and launch shows onboarding",
     lambda: ("Success" in inst and bool(find(r"Humans and agents")), f"install={inst.strip()[-20:]} version={version.group(1) if version else '?'}"))


def onboarding():
    tap(r"^Get started$")
    tap(r"^Continue$")
    txt = screen_text()
    tap(r"^Continue$")
    return bool(re.search(r"did:key:z", txt)), re.search(r"did:key:\S+", txt).group(0) if re.search(r"did:key:\S+", txt) else "no did"


step("onboarding shows the device did:key", onboarding)


def lock_step():
    txt = screen_text()
    ok = "Protect Bond" in txt and "Nothing." in txt and "PIN." in txt
    tap(r"^Nothing\. ")
    tap(r"^Continue$")
    tap(r"^Enter Bond$")
    return ok, "lock choices shown: Nothing, PIN, Fingerprint or face"


step("first-run lock choice, then enter Bond", lock_step)
step("home shows an empty rooms list", lambda: wait_for(r"No rooms yet", 15))


def create_room():
    tap(r"^Create your first room$")
    type_text("Device E2E")
    tap(r"^Create room$", -1)
    return wait_for(r"1 human · 1 agent", 15)


step("create a room with the Bond agent", create_room)


def agent_turn():
    tap(r"^Message", -1)
    type_text("@bond what is the agent wallet devnet SOL balance?")
    tap(r"^Send message$")
    hide_keyboard()
    return wait_for(r"solana_get_balance", 75)


step("typed @bond runs a real devnet tool call", agent_turn)
step("tool card is labelled agent-reported", lambda: wait_for(r"Agent-reported\. Not a signed on-chain receipt", 10))
step("own message carries a Verified badge", lambda: wait_for(r"Verified", 5))


def create_agent():
    tap(r"^Room settings$")
    tap(r"Add an agent to this room")
    adb("shell", "input", "swipe", "540", "2000", "540", "900", "400")
    time.sleep(1)
    tap(r"^Add an agent via ")
    tap(r"^Agent name$")
    adb("shell", "input", "keyevent", "KEYCODE_MOVE_END")
    for _ in range(14):
        adb("shell", "input", "keyevent", "67")
    type_text("Scout")
    hide_keyboard()
    tap(r"^Agent persona$")
    type_text("A pirate who begins every reply with AHOY.")
    hide_keyboard()
    adb("shell", "input", "swipe", "540", "1800", "540", "1100", "300")
    time.sleep(1)
    tap(r"^Add agent$")
    return wait_for(r"Scout \(@scout\) joined", 10)


step("create agent Scout with @username and persona", create_agent)


def address_scout():
    tap(r"^Go back$")
    tap(r"^Message", -1)
    type_text("@scout introduce yourself in one line")
    tap(r"^Send message$")
    hide_keyboard()
    ok, detail = wait_for(r"AHOY[^|]{0,120}", 75)
    return ok, detail


step("typed @scout gets a reply from Scout in persona", address_scout)


def agents_tab():
    adb("shell", "input", "keyevent", "4")
    time.sleep(2)
    tap(r"^Agents$", -1)
    ok, _ = wait_for(r"(?s)@bond.*@scout|@scout.*@bond", 15)
    return ok, "Your agents lists @bond and @scout"


step("Agents tab lists your agents by @username", agents_tab)


def persistence():
    adb("shell", "am", "force-stop", PKG)
    adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(15)
    dismiss_anr()
    return wait_for(r"Device E2E", 15)


step("rooms persist across a cold restart", persistence)


def no_crash():
    log = adb("logcat", "-d")
    alive = adb("shell", "pidof", PKG).strip()
    return ("FATAL EXCEPTION" not in log and bool(alive)), f"pid={alive or 'none'}; FATAL EXCEPTION in logcat: {'yes' if 'FATAL EXCEPTION' in log else 'no'}"


step("no crash in logcat", no_crash)

summary = {
    "apk": Path(APK).name,
    "version": version.group(1) if version else None,
    "device": adb("shell", "getprop", "ro.product.model").strip() + " / Android " + adb("shell", "getprop", "ro.build.version.release").strip(),
    "server": "https://bond.zkasuran.dev",
    "ran_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "passed": sum(r["pass"] for r in results),
    "total": len(results),
    "steps": results,
}
(OUT / "results.json").write_text(json.dumps(summary, indent=2))
print(f"{summary['passed']}/{summary['total']} passed")
sys.exit(0 if summary["passed"] == summary["total"] else 1)

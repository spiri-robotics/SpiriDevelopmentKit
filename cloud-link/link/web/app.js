// The robot's link to Spiri Cloud: link it, show the code to approve while
// it waits, then what the cloud configured. Everything happens in link.py;
// this page shows api/state and posts what's clicked.

const POLL_MS = { linking: 1500, linked: 5000, unlinked: 10000 };

const $ = (id) => document.getElementById(id);
let state = null;
let timer = null;
let qrFor = null;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `${res.status} ${res.statusText}`);
  return out;
}

function ago(t) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function render(s) {
  const first = state === null;
  state = s;
  for (const id of ["unlinked", "linking", "linked"]) $(id).hidden = s.state !== id;
  $("badge").textContent = { unlinked: "Not linked", linking: "Waiting for approval", linked: "Linked" }[s.state];
  $("badge").className = `badge ${s.state}`;
  $("notice").hidden = !s.notice;
  $("notice").textContent = s.notice ?? "";

  if (s.state === "unlinked") {
    // Fields fixed by the app's settings show the setting; the others keep
    // what's being typed.
    for (const [id, fixed] of [["url", s.url_fixed], ["name", s.name_fixed]]) {
      $(id).disabled = fixed;
      if (fixed) $(id).value = s[id];
      else if (first || document.activeElement !== $(id)) $(id).value ||= s[id];
    }
    $("fixed-note").hidden = !(s.url_fixed || s.name_fixed);
  }

  if (s.state === "linking") {
    const uri = s.verification_uri_complete || s.verification_uri;
    if (qrFor !== uri) {
      qrFor = uri;
      $("qr").src = `api/qr.svg?u=${encodeURIComponent(uri)}`;
    }
    $("approve-link").href = uri;
    $("approve-link").textContent = uri;
    $("verify-uri").textContent = s.verification_uri;
    $("code").textContent = s.user_code;
    const m = Math.floor(s.expires_in / 60), sec = String(s.expires_in % 60).padStart(2, "0");
    $("expires").textContent = `Expires in ${m}:${sec}.`;
    $("poll-error").textContent = s.poll_error ?? "";
  }

  if (s.state === "linked") {
    $("l-name").textContent = s.name;
    $("l-url").href = s.url;
    $("l-url").textContent = s.url;
    $("l-id").textContent = s.drone_id ?? "";
    $("l-fetched").textContent = s.fetched ? `fetched ${ago(s.fetched)}, every ${s.interval} s` : "not fetched yet";
    $("fetch-error").textContent = s.fetch_error ?? "";
    $("mismatch").hidden = !s.url_mismatch;
    $("mismatch").textContent = s.url_mismatch
      ? `This app's settings now say ${s.url_mismatch}. Unlink to link there instead.` : "";
    $("env-file").textContent = s.env_file;
    const rows = s.config.map(({ key, value }) => {
      const tr = document.createElement("tr");
      const k = document.createElement("td");
      const v = document.createElement("td");
      k.className = "mono";
      k.textContent = key;
      v.textContent = value ?? "(hidden)";
      if (value === null) v.className = "muted";
      tr.append(k, v);
      return tr;
    });
    $("config").replaceChildren(...rows);
  } else {
    $("forget").hidden = true;
  }
}

async function refresh() {
  clearTimeout(timer);
  try {
    render(await api("api/state"));
    $("error").textContent = "";
  } catch (e) {
    $("error").textContent = `Can't reach cloud-link: ${e.message}`;
  }
  timer = setTimeout(refresh, POLL_MS[state?.state] ?? 5000);
}

// Runs a click: buttons are disabled while it's in flight, and its error
// shows under the page.
async function act(button, path, body = {}) {
  button.disabled = true;
  $("error").textContent = "";
  try {
    render(await api(path, body));
    return true;
  } catch (e) {
    $("error").textContent = e.message;
    return false;
  } finally {
    button.disabled = false;
    clearTimeout(timer);
    timer = setTimeout(refresh, POLL_MS[state?.state] ?? 5000);
  }
}

$("link-form").addEventListener("submit", (e) => {
  e.preventDefault();
  act($("link"), "api/link", { url: $("url").value, name: $("name").value });
});
$("cancel").addEventListener("click", () => act($("cancel"), "api/cancel"));
$("refresh").addEventListener("click", () => act($("refresh"), "api/refresh"));
$("unlink").addEventListener("click", async () => {
  if (!confirm("Unlink this robot from Spiri Cloud? Its cloud configuration is removed from the robot.")) return;
  // If the cloud can't be reached, offer to forget the link on this side only.
  $("forget").hidden = await act($("unlink"), "api/unlink");
});
$("forget").addEventListener("click", () => act($("forget"), "api/unlink", { force: true }));

refresh();

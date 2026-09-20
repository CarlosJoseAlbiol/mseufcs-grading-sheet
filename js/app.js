import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, sendPasswordResetEmail, updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, deleteField,
  collection, query, where, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* =========================================================
   Rating sheet definition (from the Student Audition Rating Sheet)
   ========================================================= */
const LEVELS = ["Excellent", "Very Satisfactory", "Satisfactory", "Fair", "Poor"];
const CRITERIA = [
  { key: "voice",         label: "Voice",             subs: ["Quality", "Tone"],                          points: [30, 24, 18, 12, 6] },
  { key: "musicality",    label: "Musicality",        subs: ["Interpretation", "Dynamics"],               points: [30, 24, 18, 12, 6] },
  { key: "pronunciation", label: "Pronunciation",     subs: ["Clarity", "Enunciation"],                   points: [10, 8, 6, 4, 2] },
  { key: "timing",        label: "Timing/Rhythm",     subs: ["Pace", "Synchronization with music"],       points: [10, 8, 6, 4, 2] },
  { key: "stage",         label: "Stage Presence",    subs: ["Confidence", "Expression"],                 points: [10, 8, 6, 4, 2] },
  { key: "lyrics",        label: "Mastery of Lyrics", subs: ["No error or lapses in memory"],             points: [10, 8, 6, 4, 2] }
];
const VOICE_OPTIONS = {
  S1: "Soprano 1", S2: "Soprano 2", A1: "Alto 1", A2: "Alto 2",
  T1: "Tenor 1", T2: "Tenor 2", B1: "Bass 1", B2: "Bass 2", G: "Generalized"
};
// Older accounts may still carry a single-letter voice part.
const VOICE = { ...VOICE_OPTIONS, S: "Soprano", A: "Alto", T: "Tenor", B: "Bass" };
const ROLE = { trainee: "Trainee", master: "Master of Initiation", senior: "Senior Member" };
const REACTIONS = ["Noted", "Thank you", "Will improve", "Motivated"];
const isGrader = (r) => r === "master" || r === "senior";

/* =========================================================
   Helpers
   ========================================================= */
const $ = (s, r = document) => r.querySelector(s);
const main = $("#main");
const modalRoot = $("#modal-root");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const voiceName = (v) => VOICE[v] || "Not set";
const isGroup = (a) => !a.traineeUid;
const adjLabel = (a) => a.adjudicator || `${a.graderName} (${ROLE[a.graderRole] || ""})`;
const sheetTitle = (a) => a.traineeName || (a.voicePart === "G" ? "Generalized (whole choir)" : `${voiceName(a.voicePart)} section`);
const ms = (t) => (t && t.toMillis ? t.toMillis() : Date.now());
const byNewest = (a, b) => (b.date || "").localeCompare(a.date || "") || ms(b.createdAt) - ms(a.createdAt);
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fmtDate = (s) => {
  if (!s) return "";
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" });
};
const fmtStamp = (t) =>
  t && t.toDate ? t.toDate().toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Just now";

const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs change() and animates the element's height from old to new, so nothing jumps.
function morph(el, change) {
  if (reduceMotion) return change();
  const h0 = el.offsetHeight;
  change();
  const h1 = el.offsetHeight;
  if (Math.abs(h0 - h1) < 2) return;
  el.style.height = h0 + "px";
  el.style.overflow = "hidden";
  el.getBoundingClientRect();
  el.style.transition = "height 0.5s cubic-bezier(0.22, 0.8, 0.24, 1)";
  el.style.height = h1 + "px";
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    el.style.height = "";
    el.style.overflow = "";
    el.style.transition = "";
  };
  el.addEventListener("transitionend", (e) => { if (e.propertyName === "height") done(); });
  setTimeout(done, 650);
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2800);
}

/* =========================================================
   Firebase
   ========================================================= */
const configured = !String(firebaseConfig.apiKey).startsWith("YOUR_");
let auth, db;
if (configured) {
  const fbApp = initializeApp(firebaseConfig);
  auth = getAuth(fbApp);
  db = getFirestore(fbApp);
}

const state = {
  user: null,
  profile: null,
  assessments: [],
  trainees: [],
  unsubs: [],
  view: "dashboard",
  editing: null,
  filter: { q: "", voice: "" }
};
let busy = false;
let authGroup = "trainee";
let authMode = "signin";
let modalUnsubs = [];

/* Password gate for the Master / Senior Member tab.
   The same password is sent as the sign-up access code, so set the
   "code" field of config/invite in Firestore to this value. */
const GATE_CODE = "1974";
let unlockedCode = "";
try { if (sessionStorage.getItem("gateCode") === GATE_CODE) unlockedCode = GATE_CODE; } catch (_) { /* ignore */ }

/* =========================================================
   Auth screen
   ========================================================= */
function showAuthError(msg) {
  const el = $("#auth-error");
  const apply = () => { el.textContent = msg; el.hidden = !msg; };
  if (msg && el.hidden && !$("#auth-view").hidden) morph($("#auth-form"), apply);
  else apply();
}

// Fades the card contents out, swaps them, glides the card to its new height, then fades back in.
let authBusy = false;
async function transitionAuth(change) {
  if (reduceMotion) return change();
  if (authBusy) return;
  authBusy = true;
  const card = $("#auth-form");
  card.classList.add("swap-out");
  await wait(170);
  morph(card, change);
  await wait(30);
  card.classList.remove("swap-out");
  await wait(450);
  authBusy = false;
}

function syncAuthUI() {
  const signin = authMode === "signin";
  $("#auth-title").textContent = signin ? "Sign in" : "Create account";
  $("#auth-submit").textContent = signin ? "Sign in" : "Create account";
  $("#swap-text").textContent = signin ? "New here?" : "Already have an account?";
  $("#swap-mode").textContent = signin ? "Create an account" : "Sign in";
  $("#f-pass").autocomplete = signin ? "current-password" : "new-password";
  document.querySelectorAll("#auth-view [data-mode], #auth-view [data-for]").forEach((el) => {
    const m = !el.dataset.mode || el.dataset.mode === authMode;
    const g = !el.dataset.for || el.dataset.for === authGroup;
    el.hidden = !(m && g);
  });
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.group === authGroup)));
  $(".seg").dataset.active = authGroup;
  $("#acct-type").textContent = authGroup === "grader" ? "Master of Initiation / Senior Member account" : "Trainee account";
}

const MESSAGES = {
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/wrong-password": "Email or password is incorrect.",
  "auth/user-not-found": "Email or password is incorrect.",
  "auth/invalid-login-credentials": "Email or password is incorrect.",
  "auth/email-already-in-use": "That email already has an account. Sign in instead.",
  "auth/weak-password": "Use a password with at least 6 characters.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/too-many-requests": "Too many attempts. Wait a moment, then try again.",
  "auth/network-request-failed": "No connection. Check your internet and try again.",
  "auth/operation-not-allowed": "Email/Password sign-in is not turned on in Firebase yet.",
  "auth/invalid-api-key": "Firebase is not set up yet. Add your config to js/firebase-config.js.",
  "auth/api-key-not-valid.-please-pass-a-valid-api-key.": "Firebase is not set up yet. Add your config to js/firebase-config.js.",
  "need-name": "Enter your full name.",
  "need-program": "Enter your program and year level.",
  "need-code": "Unlock the Master / Senior Member tab with the password first.",
  "bad-code": "That access code is not valid. Ask your officers for the current code.",
  "no-profile": "This account has no profile. Create an account first.",
  "wrong-group-grader": "This account is a Trainee account. Switch to Trainee above.",
  "wrong-group-trainee": "This account is a Master / Senior Member account. Switch to Master / Senior Member above."
};
function friendly(err) {
  console.error(err);
  return MESSAGES[err.code] || MESSAGES[err.message] || "Something went wrong. Please try again.";
}

async function loadProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

async function doSignIn(email, pass) {
  const cred = await signInWithEmailAndPassword(auth, email, pass);
  const profile = await loadProfile(cred.user.uid);
  if (!profile) {
    await signOut(auth);
    throw new Error("no-profile");
  }
  if (isGrader(profile.role) !== (authGroup === "grader")) {
    await signOut(auth);
    throw new Error(authGroup === "grader" ? "wrong-group-trainee" : "wrong-group-grader");
  }
  enterApp(cred.user, profile);
}

async function doSignUp(email, pass) {
  const name = $("#f-name").value.trim();
  if (!name) throw new Error("need-name");
  let extra;
  if (authGroup === "trainee") {
    const program = $("#f-program").value.trim();
    if (!program) throw new Error("need-program");
    extra = { role: "trainee", program, voicePart: $("#f-voice").value };
  } else {
    if (!unlockedCode) throw new Error("need-code");
    extra = { role: $("#f-position").value, inviteCode: unlockedCode };
  }
  const cred = await createUserWithEmailAndPassword(auth, email, pass);
  try {
    await setDoc(doc(db, "users", cred.user.uid), { name, email, ...extra, createdAt: serverTimestamp() });
  } catch (err) {
    try { await cred.user.delete(); } catch (_) { /* ignore */ }
    if (err.code === "permission-denied" && authGroup === "grader") throw new Error("bad-code");
    throw err;
  }
  if (extra.inviteCode) updateDoc(doc(db, "users", cred.user.uid), { inviteCode: deleteField() }).catch(() => {});
  updateProfile(cred.user, { displayName: name }).catch(() => {});
  const profile = await loadProfile(cred.user.uid);
  enterApp(cred.user, profile);
}

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showAuthError("");
  const email = $("#f-email").value.trim();
  const pass = $("#f-pass").value;
  if (!email || !pass) return showAuthError("Enter your email and password.");
  const btn = $("#auth-submit");
  btn.disabled = true;
  busy = true;
  try {
    if (authMode === "signin") await doSignIn(email, pass);
    else await doSignUp(email, pass);
  } catch (err) {
    showAuthError(friendly(err));
  } finally {
    busy = false;
    btn.disabled = false;
  }
});

document.querySelectorAll(".seg button").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.group === "grader" && !unlockedCode) return openGate();
    if (b.dataset.group === authGroup) return;
    transitionAuth(() => {
      authGroup = b.dataset.group;
      showAuthError("");
      syncAuthUI();
    });
  })
);

/* ----- password gate ----- */
const gate = $("#gate");
function gateError(msg) {
  const el = $("#gate-error");
  el.textContent = msg;
  el.hidden = !msg;
}
function openGate() {
  $("#gate-input").value = "";
  gateError("");
  gate.hidden = false;
  $("#gate-input").focus();
}
function closeGate() {
  if (gate.hidden || gate.classList.contains("closing")) return;
  if (reduceMotion) { gate.hidden = true; return; }
  gate.classList.add("closing");
  setTimeout(() => { gate.hidden = true; gate.classList.remove("closing"); }, 220);
}
$("#gate-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = $("#gate-input").value.trim();
  if (value !== GATE_CODE) return gateError("Wrong password. Ask your officers for the password.");
  unlockedCode = value;
  try { sessionStorage.setItem("gateCode", value); } catch (_) { /* ignore */ }
  closeGate();
  transitionAuth(() => {
    authGroup = "grader";
    showAuthError("");
    syncAuthUI();
  });
});
$("#gate-cancel").addEventListener("click", closeGate);
gate.addEventListener("mousedown", (e) => { if (e.target === gate) closeGate(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !gate.hidden) closeGate(); });
$("#swap-mode").addEventListener("click", () => {
  transitionAuth(() => {
    authMode = authMode === "signin" ? "signup" : "signin";
    showAuthError("");
    syncAuthUI();
  });
});
$("#forgot").addEventListener("click", async () => {
  const email = $("#f-email").value.trim();
  if (!email) return showAuthError("Enter your email above, then select Forgot password.");
  try {
    await sendPasswordResetEmail(auth, email);
    showAuthError("");
    toast("Password reset email sent.");
  } catch (err) {
    showAuthError(friendly(err));
  }
});
$("#logout").addEventListener("click", () => signOut(auth));

/* =========================================================
   Session
   ========================================================= */
function showAuth() {
  $("#boot").hidden = true;
  $("#app-view").hidden = true;
  $("#auth-view").hidden = false;
  syncAuthUI();
}

function teardown() {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
  closeModal(true);
}

function leaveApp() {
  teardown();
  Object.assign(state, { user: null, profile: null, assessments: [], trainees: [], view: "dashboard", editing: null });
  $("#auth-form").reset();
  authMode = "signin";
}

function enterApp(user, profile) {
  teardown();
  state.user = user;
  state.profile = profile;
  state.view = "dashboard";
  $("#boot").hidden = true;
  const av = $("#auth-view");
  const showShell = () => {
    av.hidden = true;
    av.classList.remove("out");
    $("#app-view").hidden = false;
    render();
    animateMain();
    window.scrollTo(0, 0);
  };
  $("#who-name").textContent = profile.name;
  $("#who-role").textContent = ROLE[profile.role] || "";

  const grader = isGrader(profile.role);
  const col = collection(db, "assessments");
  const listenErr = (err) => { console.error(err); toast("Could not load rating sheets. Check your Firestore rules."); };
  const publish = (sources) => {
    const seen = new Map();
    Object.values(sources).forEach((list) => list.forEach((a) => seen.set(a.id, a)));
    state.assessments = [...seen.values()].sort(byNewest);
    if (state.view === "dashboard") render();
  };
  const mapDocs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (grader) {
    state.unsubs.push(onSnapshot(col, (snap) => publish({ all: mapDocs(snap) }), listenErr));
  } else {
    // Trainees see: their own sheets, sheets for their section, and whole-choir sheets.
    const sources = { mine: [], section: [], choir: [] };
    state.unsubs.push(onSnapshot(query(col, where("traineeUid", "==", user.uid)), (snap) => { sources.mine = mapDocs(snap); publish(sources); }, listenErr));
    if (profile.voicePart) {
      state.unsubs.push(onSnapshot(query(col, where("traineeUid", "==", ""), where("voicePart", "==", profile.voicePart)), (snap) => { sources.section = mapDocs(snap); publish(sources); }, listenErr));
    }
    state.unsubs.push(onSnapshot(query(col, where("traineeUid", "==", ""), where("voicePart", "==", "G")), (snap) => { sources.choir = mapDocs(snap); publish(sources); }, listenErr));
  }
  if (grader) {
    state.unsubs.push(
      onSnapshot(query(collection(db, "users"), where("role", "==", "trainee")), (snap) => {
        state.trainees = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      })
    );
  }
  if (!av.hidden && !reduceMotion) {
    av.classList.add("out");
    setTimeout(showShell, 320);
  } else {
    showShell();
  }
}

if (!configured) {
  showAuth();
  showAuthError("Firebase is not set up yet. Paste your config into js/firebase-config.js, then reload.");
  $("#auth-submit").disabled = true;
} else {
  onAuthStateChanged(auth, async (user) => {
    if (busy) return;
    if (!user) {
      leaveApp();
      showAuth();
      return;
    }
    try {
      const profile = await loadProfile(user.uid);
      if (!profile) { await signOut(auth); return; }
      enterApp(user, profile);
    } catch (err) {
      console.error(err);
      showAuth();
      showAuthError("Could not load your account. Check your connection and Firestore rules.");
    }
  });
}

/* =========================================================
   Rubric table (shared by the form and the read-only view)
   ========================================================= */
function rubricHTML({ scores = {}, mode }) {
  const editable = mode === "edit";
  const total = CRITERIA.reduce((s, c) => s + (scores[c.key] ? scores[c.key].points : 0), 0);
  const rows = CRITERIA.map((c) => {
    const sel = scores[c.key] ? scores[c.key].level : null;
    const cells = LEVELS.map((lvl, i) =>
      editable
        ? `<td><label class="cell"><input type="radio" name="crit-${c.key}" value="${i}" aria-label="${esc(c.label)}: ${lvl}, ${c.points[i]} points" ${sel === i ? "checked" : ""}><span>${c.points[i]}</span></label></td>`
        : `<td><div class="cell static ${sel === i ? "on" : ""}" ${sel === i ? 'aria-label="Selected"' : ""}><span>${c.points[i]}</span></div></td>`
    ).join("");
    return `<tr>
      <th scope="row">${esc(c.label)}<ul>${c.subs.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></th>
      ${cells}
      <td class="pts" data-pts="${c.key}">${sel !== null ? c.points[sel] : "–"}</td>
    </tr>`;
  }).join("");
  return `<div class="rubric-wrap"><table class="rubric">
    <thead><tr><th scope="col">Criteria</th>${LEVELS.map((l) => `<th scope="col">${l}</th>`).join("")}<th scope="col">Points</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><th colspan="6" scope="row">Total</th><td id="rubric-total">${total}/100</td></tr></tfoot>
  </table></div>`;
}

function readScores() {
  const scores = {};
  let total = 0;
  let complete = true;
  CRITERIA.forEach((c) => {
    const picked = main.querySelector(`input[name="crit-${c.key}"]:checked`);
    if (!picked) { complete = false; return; }
    const level = Number(picked.value);
    scores[c.key] = { level, label: LEVELS[level], points: c.points[level] };
    total += c.points[level];
  });
  return { scores, total, complete };
}

function updateTotals() {
  const { scores, total } = readScores();
  CRITERIA.forEach((c) => {
    const cell = main.querySelector(`[data-pts="${c.key}"]`);
    if (cell) cell.textContent = scores[c.key] ? scores[c.key].points : "–";
  });
  const totalEl = $("#rubric-total");
  totalEl.textContent = `${total}/100`;
  totalEl.classList.remove("bump");
  void totalEl.offsetWidth;
  totalEl.classList.add("bump");
}

/* =========================================================
   Motion
   ========================================================= */
let enterTimer;

function countUp() {
  main.querySelectorAll(".stat .num").forEach((el) => {
    const txt = el.textContent.trim();
    const n = parseFloat(txt);
    if (Number.isNaN(n)) return;
    const dec = txt.includes(".") ? 1 : 0;
    const start = performance.now();
    const tick = (t) => {
      const k = Math.min(1, (t - start) / 850);
      el.textContent = (n * (1 - Math.pow(1 - k, 3))).toFixed(dec);
      if (k < 1) requestAnimationFrame(tick);
      else el.textContent = txt;
    };
    requestAnimationFrame(tick);
  });
}

// Plays the "page enter" animation. Called when the view changes, not on every live data update.
function animateMain() {
  if (reduceMotion) return;
  main.classList.remove("enter");
  [...main.children].forEach((el, i) => el.style.setProperty("--i", i));
  main.querySelectorAll(".stat, .card-a").forEach((el, i) => el.style.setProperty("--j", i));
  main.querySelectorAll("#rows tr").forEach((el, i) => el.style.setProperty("--r", Math.min(i, 12)));
  void main.offsetWidth;
  main.classList.add("enter");
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => main.classList.remove("enter"), 1900);
  countUp();
}

let navBusy = false;
async function goto(fn) {
  if (reduceMotion) return fn();
  if (navBusy) return;
  navBusy = true;
  main.classList.add("leaving");
  await wait(190);
  fn();
  main.classList.remove("leaving");
  navBusy = false;
}

function showDashboard() {
  state.view = "dashboard";
  state.editing = null;
  render();
  animateMain();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* =========================================================
   Dashboards
   ========================================================= */
function render() {
  if (!state.profile) return;
  if (state.view === "form") return;
  isGrader(state.profile.role) ? renderGraderDashboard() : renderTraineeDashboard();
}

function renderGraderDashboard() {
  const all = state.assessments;
  const avg = all.length ? (all.reduce((s, a) => s + a.total, 0) / all.length).toFixed(1) : "–";
  const graded = new Set(all.filter((a) => a.traineeUid).map((a) => a.traineeUid)).size;
  const mine = all.filter((a) => a.graderUid === state.user.uid).length;
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Rating dashboard</h2>
        <p>Grade trainee auditions and reply to their comments.</p>
      </div>
      <button class="btn btn-primary" id="new-sheet" type="button">New rating sheet</button>
    </div>
    <div class="staff" aria-hidden="true"></div>
    <div class="stats">
      <div class="stat"><div class="num">${all.length}</div><div class="lbl">Rating sheets</div></div>
      <div class="stat"><div class="num">${graded}</div><div class="lbl">Trainees rated</div></div>
      <div class="stat"><div class="num">${avg}</div><div class="lbl">Average score</div></div>
      <div class="stat"><div class="num">${mine}</div><div class="lbl">Sheets by you</div></div>
    </div>
    <div class="toolbar">
      <input id="q" type="search" placeholder="Search by trainee or section" aria-label="Search by trainee or section" value="${esc(state.filter.q)}">
      <select id="vf" aria-label="Filter by voice part">
        <option value="">All voice parts</option>
        ${Object.entries(VOICE_OPTIONS).map(([k, label]) => `<option value="${k}" ${state.filter.voice === k ? "selected" : ""}>${label}</option>`).join("")}
      </select>
    </div>
    <div class="panel"><div class="table-wrap">
      <table class="list">
        <thead><tr><th>Trainee</th><th>Voice part</th><th>Date</th><th>Total</th><th>Adjudicator</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div></div>`;
  renderRows();
}

function renderRows() {
  const { q, voice } = state.filter;
  const rows = state.assessments.filter(
    (a) => (!voice || a.voicePart === voice) && (!q || sheetTitle(a).toLowerCase().includes(q.toLowerCase()))
  );
  const body = $("#rows");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5"><div class="empty">${
      state.assessments.length
        ? "No rating sheets match your search."
        : "No rating sheets yet. Select New rating sheet to grade your first trainee."
    }</div></td></tr>`;
    return;
  }
  body.innerHTML = rows.map((a) => `
    <tr data-id="${a.id}" tabindex="0">
      <td><strong>${esc(sheetTitle(a))}</strong><div class="hint">${isGroup(a) ? "Group assessment" : esc(a.program)}</div></td>
      <td><span class="tag">${esc(voiceName(a.voicePart))}</span></td>
      <td>${esc(fmtDate(a.date))}</td>
      <td><span class="score-pill">${a.total}<small>/100</small></span></td>
      <td>${esc(a.adjudicator || a.graderName)}<div class="hint">${a.adjudicator ? `Recorded by ${esc(a.graderName)}` : esc(ROLE[a.graderRole] || "")}</div></td>
    </tr>`).join("");
}

function renderTraineeDashboard() {
  const all = state.assessments;
  const avg = all.length ? (all.reduce((s, a) => s + a.total, 0) / all.length).toFixed(1) : "–";
  const latest = all.length ? all[0].total : "–";
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Hello, ${esc(state.profile.name.split(" ")[0])}</h2>
        <p>Your ratings, including those for your section. Open a sheet to read the comments and reply.</p>
      </div>
    </div>
    <div class="staff" aria-hidden="true"></div>
    <div class="stats">
      <div class="stat"><div class="num">${all.length}</div><div class="lbl">Rating sheets received</div></div>
      <div class="stat"><div class="num">${latest}</div><div class="lbl">Latest score</div></div>
      <div class="stat"><div class="num">${avg}</div><div class="lbl">Average score</div></div>
    </div>
    ${
      all.length
        ? `<div class="cards">${all.map((a) => `
          <button class="card-a" type="button" data-id="${a.id}">
            <div class="big">${a.total}<small>/100</small></div>
            <div><strong>${esc(fmtDate(a.date))}</strong></div>
            <div class="meta">${isGroup(a) ? `Group: ${esc(sheetTitle(a))}` : esc(voiceName(a.voicePart))}<br>Rated by ${esc(adjLabel(a))}</div>
          </button>`).join("")}</div>`
        : `<div class="panel"><div class="empty"><p>No rating sheets yet.</p><p class="hint">When a Master of Initiation or Senior Member rates you or your section, it will show up here.</p></div></div>`
    }`;
}

/* =========================================================
   Rating form (Masters of Initiation and Senior Members)
   ========================================================= */
function renderForm(existing = null) {
  state.view = "form";
  state.editing = existing;
  const p = state.profile;
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h2>${existing ? "Edit rating sheet" : "New rating sheet"}</h2>
        <p>Grade a whole section, one trainee, or both. Points and total are calculated for you.</p>
      </div>
      <button class="btn" id="cancel-form" type="button">Back to dashboard</button>
    </div>
    <div class="staff" aria-hidden="true"></div>
    <form id="sheet" class="sheet" novalidate>
      <div class="sheet-head">
        <label class="field">
          <span>Section / group</span>
          <select id="s-section">
            <option value="">No section</option>
            ${Object.entries(VOICE_OPTIONS).map(([k, label]) => `<option value="${k}">${label}</option>`).join("")}
          </select>
          <span class="hint">Pick a section to grade the whole group.</span>
        </label>
        <label class="field">
          <span>Trainee (optional)</span>
          <select id="s-trainee" ${existing ? "disabled" : ""}>
            <option value="">No specific trainee (group)</option>
            ${state.trainees.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}
          </select>
          <span class="hint">${!existing && !state.trainees.length ? "No trainees have signed up yet." : "Pick a trainee to grade one person."}</span>
        </label>
        <label class="field"><span>Program and year level (optional)</span><input id="s-program" type="text"></label>
        <label class="field"><span>Date</span><input id="s-date" type="date"></label>
      </div>
      ${rubricHTML({ scores: existing ? existing.scores : {}, mode: "edit" })}
      <label class="field"><span>Comment</span><textarea id="s-comment" maxlength="2000" placeholder="Strengths, what to work on, next steps"></textarea></label>
      <label class="field"><span>Adjudicator</span><input id="s-adj" type="text" maxlength="120" value="${esc(existing ? adjLabel(existing) : `${p.name} (${ROLE[p.role]})`)}"></label>
      <div id="form-error" class="form-error" role="alert" hidden></div>
      <div class="actions">
        <button class="btn" id="cancel2" type="button">Cancel</button>
        <button class="btn btn-primary" type="submit">Save rating sheet</button>
      </div>
    </form>`;
  $("#s-date").value = existing ? existing.date : todayStr();
  if (existing) {
    $("#s-trainee").innerHTML = `<option>${esc(existing.traineeName || "None (group sheet)")}</option>`;
    $("#s-section").value = existing.voicePart || "";
    $("#s-program").value = existing.program || "";
    $("#s-comment").value = existing.comment || "";
  }
  animateMain();
  window.scrollTo(0, 0);
}

function formError(msg) {
  const el = $("#form-error");
  el.textContent = msg;
  el.hidden = !msg;
  if (msg) el.scrollIntoView({ block: "center", behavior: "smooth" });
}

async function saveSheet() {
  formError("");
  const ex = state.editing;
  const traineeUid = ex ? ex.traineeUid : $("#s-trainee").value;
  const section = $("#s-section").value;
  if (!traineeUid && !section) return formError("Select a section, a trainee, or both.");
  const { scores, total, complete } = readScores();
  if (!complete) return formError("Rate every criterion before saving.");
  const date = $("#s-date").value;
  if (!date) return formError("Enter the audition date.");
  const trainee = state.trainees.find((t) => t.id === traineeUid);
  const data = {
    traineeUid,
    traineeName: ex ? ex.traineeName || "" : trainee ? trainee.name : "",
    program: $("#s-program").value.trim(),
    voicePart: section || (ex && ex.voicePart) || (trainee && trainee.voicePart) || "",
    date,
    scores,
    total,
    comment: $("#s-comment").value.trim(),
    adjudicator: $("#s-adj").value.trim() || `${state.profile.name} (${ROLE[state.profile.role]})`,
    graderUid: state.user.uid,
    graderName: state.profile.name,
    graderRole: state.profile.role,
    updatedAt: serverTimestamp()
  };
  const btn = main.querySelector('#sheet button[type="submit"]');
  btn.disabled = true;
  try {
    if (ex) await updateDoc(doc(db, "assessments", ex.id), data);
    else await addDoc(collection(db, "assessments"), { ...data, createdAt: serverTimestamp() });
    goto(showDashboard);
    toast("Rating sheet saved");
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    formError("Could not save the rating sheet. Check your connection and Firestore rules, then try again.");
  }
}

/* =========================================================
   Detail dialog: read-only sheet, reactions, comments
   ========================================================= */
function closeModal(immediate = false) {
  modalUnsubs.forEach((u) => u());
  modalUnsubs = [];
  document.removeEventListener("keydown", onEsc);
  const ov = $("#ov");
  if (!ov || immediate || reduceMotion) { modalRoot.innerHTML = ""; return; }
  ov.classList.add("closing");
  setTimeout(() => { if (ov.isConnected && ov.classList.contains("closing")) ov.remove(); }, 230);
}
function onEsc(e) { if (e.key === "Escape") closeModal(); }

function openDetail(id) {
  const a = state.assessments.find((x) => x.id === id);
  if (!a) return;
  closeModal(true);
  const uid = state.user.uid;
  const mine = a.graderUid === uid;

  modalRoot.innerHTML = `
    <div class="overlay" id="ov">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
        <div class="dialog-head">
          <div>
            <h2 id="dlg-title">${esc(sheetTitle(a))}</h2>
            <div class="meta">${isGroup(a) ? "<span>Group assessment</span>" : `<span>${esc(voiceName(a.voicePart))}</span>${a.program ? `<span>${esc(a.program)}</span>` : ""}`}<span>${esc(fmtDate(a.date))}</span></div>
          </div>
          <div class="total-box"><div class="big">${a.total}</div><small>out of 100</small></div>
        </div>

        ${rubricHTML({ scores: a.scores, mode: "view" })}

        <div>
          <div class="section-title">Adjudicator's comment</div>
          ${a.comment ? `<p class="quote">${esc(a.comment)}</p>` : '<p class="hint">No comment was left on this sheet.</p>'}
          <p class="hint" style="margin-top:.5rem">Adjudicator: ${esc(adjLabel(a))}</p>
        </div>

        <div>
          <div class="section-title">Reactions</div>
          <div class="chips" id="chips"></div>
        </div>

        <div>
          <div class="section-title">Replies</div>
          <div class="thread" id="thread"><p class="hint">Loading replies…</p></div>
          <form id="cmt-form" class="compose" novalidate>
            <textarea id="cmt-text" maxlength="1000" placeholder="Write a reply" aria-label="Write a reply"></textarea>
            <div class="actions"><button class="btn btn-primary btn-sm" type="submit">Post reply</button></div>
          </form>
        </div>

        <div class="actions">
          ${mine ? '<button class="btn" id="edit-sheet" type="button">Edit sheet</button><button class="btn" id="delete-sheet" type="button">Delete sheet</button>' : ""}
          <button class="btn btn-primary" id="close-dlg" type="button">Close</button>
        </div>
      </div>
    </div>`;

  const dlg = $(".dialog", modalRoot);
  dlg.focus();
  document.addEventListener("keydown", onEsc);
  $("#ov").addEventListener("mousedown", (e) => { if (e.target.id === "ov") closeModal(); });
  $("#close-dlg").addEventListener("click", closeModal);

  const commentsCol = collection(db, "assessments", id, "comments");
  const reactionsCol = collection(db, "assessments", id, "reactions");

  // Reactions
  let reactions = [];
  const paintChips = () => {
    const myReaction = (reactions.find((r) => r.id === uid) || {}).label;
    $("#chips").innerHTML = REACTIONS.map((label) => {
      const n = reactions.filter((r) => r.label === label).length;
      return `<button class="chip" type="button" data-react="${esc(label)}" aria-pressed="${myReaction === label}">${esc(label)}${n ? `<b>${n}</b>` : ""}</button>`;
    }).join("");
  };
  paintChips();
  modalUnsubs.push(onSnapshot(reactionsCol, (snap) => {
    reactions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    paintChips();
  }, (err) => console.error(err)));
  $("#chips").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-react]");
    if (!btn) return;
    const label = btn.dataset.react;
    const mineNow = (reactions.find((r) => r.id === uid) || {}).label;
    try {
      if (mineNow === label) await deleteDoc(doc(db, "assessments", id, "reactions", uid));
      else await setDoc(doc(db, "assessments", id, "reactions", uid), { label, name: state.profile.name, createdAt: serverTimestamp() });
    } catch (err) { console.error(err); toast("Could not save your reaction."); }
  });

  // Comments
  modalUnsubs.push(onSnapshot(commentsCol, (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((x, y) => ms(x.createdAt) - ms(y.createdAt));
    const thread = $("#thread");
    if (!thread) return;
    thread.innerHTML = list.length
      ? list.map((c) => `
        <div class="msg">
          <div class="msg-top">
            <span><strong>${esc(c.authorName)}</strong> · ${esc(ROLE[c.authorRole] || "")}</span>
            <span>${esc(fmtStamp(c.createdAt))}${c.authorUid === uid || mine ? ` <button class="btn-link" type="button" data-del="${c.id}">Delete</button>` : ""}</span>
          </div>
          <p>${esc(c.text)}</p>
        </div>`).join("")
      : '<p class="hint">No replies yet.</p>';
  }, (err) => console.error(err)));

  $("#thread").addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del]");
    if (!del) return;
    try { await deleteDoc(doc(db, "assessments", id, "comments", del.dataset.del)); }
    catch (err) { console.error(err); toast("Could not delete the reply."); }
  });

  $("#cmt-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const box = $("#cmt-text");
    const text = box.value.trim();
    if (!text) return;
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      await addDoc(commentsCol, {
        authorUid: uid,
        authorName: state.profile.name,
        authorRole: state.profile.role,
        text,
        createdAt: serverTimestamp()
      });
      box.value = "";
    } catch (err) { console.error(err); toast("Could not post your reply."); }
    btn.disabled = false;
  });

  if (mine) {
    $("#edit-sheet").addEventListener("click", () => { closeModal(); goto(() => renderForm(a)); });
    $("#delete-sheet").addEventListener("click", async () => {
      if (!confirm(`Delete the rating sheet for ${sheetTitle(a)}? This cannot be undone.`)) return;
      try {
        const [cs, rs] = await Promise.all([getDocs(commentsCol), getDocs(reactionsCol)]);
        await Promise.all([...cs.docs, ...rs.docs].map((d) => deleteDoc(d.ref)));
        await deleteDoc(doc(db, "assessments", id));
        closeModal();
        toast("Rating sheet deleted");
      } catch (err) { console.error(err); toast("Could not delete the rating sheet."); }
    });
  }
}

/* =========================================================
   Main-area events (delegated, since the content is re-rendered)
   ========================================================= */
main.addEventListener("click", (e) => {
  if (e.target.closest("#new-sheet")) return goto(() => renderForm());
  if (e.target.closest("#cancel-form, #cancel2")) return goto(showDashboard);
  const row = e.target.closest("[data-id]");
  if (row) openDetail(row.dataset.id);
});
main.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const row = e.target.closest("tr[data-id]");
  if (row) openDetail(row.dataset.id);
});
main.addEventListener("input", (e) => {
  if (e.target.id === "q") { state.filter.q = e.target.value.trim(); renderRows(); }
});
main.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "vf") { state.filter.voice = t.value; renderRows(); }
  else if (t.name && t.name.startsWith("crit-")) updateTotals();
  else if (t.id === "s-trainee") {
    const tr = state.trainees.find((x) => x.id === t.value);
    if (tr) {
      $("#s-program").value = tr.program || "";
      if (VOICE_OPTIONS[tr.voicePart]) $("#s-section").value = tr.voicePart;
    }
  }
});
main.addEventListener("submit", (e) => {
  if (e.target.id === "sheet") { e.preventDefault(); saveSheet(); }
});

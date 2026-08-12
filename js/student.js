import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import { getFirestore, collection, getDocs, query, where, orderBy } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";

const app = initializeApp(window.firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Autenticación anónima e invisible para el estudiante: no pide nada,
// solo permite que las reglas de Firestore exijan "request.auth != null"
// y así bloqueen lecturas que no pasen por esta aplicación.
let authReady = signInAnonymously(auth).catch(err => {
    console.error('No se pudo iniciar sesión anónima:', err);
});

// ── CONSTANTS ───────────────────────────────────────────────
const ETHICS_LEVELS = [
    { min: 0,   name: "Aprendiz",         icon: "🌱",
      desc: "Estás comenzando tu camino ético. Cada acción cuenta.",
      nextHint: "Asiste a clases y participa para avanzar." },
    { min: 50,  name: "Curioso/a",        icon: "🔍",
      desc: "Empiezas a hacerte preguntas importantes sobre lo que está bien.",
      nextHint: "Sigue reflexionando y participando en las actividades." },
    { min: 120, name: "Reflexivo/a",      icon: "💭",
      desc: "Piensas antes de actuar. Eso marca la diferencia.",
      nextHint: "Comparte tus ideas con el grupo y asume compromisos." },
    { min: 220, name: "Comprometido/a",   icon: "🤝",
      desc: "Tus acciones muestran que la ética no es solo teoría para ti.",
      nextHint: "Lidera con el ejemplo y apoya a quienes te rodean." },
    { min: 350, name: "Ético/a Activo/a", icon: "🔥",
      desc: "Eres un referente. Los demás aprenden de tu forma de actuar.",
      nextHint: "Un último esfuerzo — la Guía Ética está muy cerca." },
    { min: 500, name: "Guía Ética",       icon: "🌟",
      desc: "Has alcanzado el nivel más alto. Eres un ejemplo de vida ética.",
      nextHint: null }
];

function getMotivMessage(lvl, ptsToNext) {
    if (!lvl.nextName) return "🏆 ¡Alcanzaste el nivel máximo! Eres un ejemplo de vida ética para tu curso.";
    if (ptsToNext <= 5)  return `⚡ ¡Solo ${ptsToNext} punto${ptsToNext===1?'':'s'} para ser ${lvl.nextName}! ¡Casi lo tienes!`;
    if (ptsToNext <= 15) return `🔥 ¡Muy cerca! Te faltan ${ptsToNext} puntos para llegar a ${lvl.nextName}.`;
    if (ptsToNext <= 30) return `💪 Vas muy bien. ${ptsToNext} puntos más y serás ${lvl.nextName}.`;
    return `🎯 Meta: ${lvl.nextName} · Te faltan ${ptsToNext} puntos.`;
}
const REWARDS = [
    { id:'pc',      icon:'💻', name:'Cambiar de computador',             cost:15 },
    { id:'turn',    icon:'🔄', name:'Cambiar turno de actividad',        cost:20 },
    { id:'order',   icon:'📋', name:'Elegir orden de participación',     cost:25 },
    { id:'chest',   icon:'📦', name:'Abrir Cofre Misterioso',            cost:30 },
    { id:'plus2',   icon:'➕', name:'+2 puntos a una actividad',          cost:20 },
    { id:'plus3',   icon:'➕', name:'+3 puntos a una actividad',          cost:30 },
    { id:'grade',   icon:'📈', name:'Mejorar tu calificación',           cost:40 },
    { id:'double',  icon:'🌀', name:'Duplicar monedas siguiente misión', cost:25 },
    { id:'gift',    icon:'🎁', name:'Otorgar 10 pts a un compañero',     cost:15 },
    { id:'recover', icon:'🛡️', name:'Recuperar hasta 5 pts perdidos',   cost:20 },
    { id:'time',    icon:'⏰', name:'Tiempo extra para entregar',        cost:35 },
    { id:'early',   icon:'🚪', name:'Salir más temprano de clase',       cost:50 },
];
const COURSE_NAMES = { 6:'6°', 7:'7°', 8:'8°', 9:'9°', 10:'10°', 11:'11°' };

// ── SESSION ──────────────────────────────────────────────────
// NOTA DE SEGURIDAD: esta app se usa en equipos compartidos (sala de
// cómputo). Por eso NO se guarda ni se restaura sesión entre cargas de
// página: cada vez que se abre/recarga Student.html, el estudiante debe
// ingresar su documento de nuevo. No usar localStorage aquí.
let currentStudent = null;

// ── NOTIFICATIONS ────────────────────────────────────────────
// sessionStorage: se borra automáticamente al cerrar la pestaña/navegador,
// para no dejar datos de un estudiante disponibles al siguiente en un
// equipo compartido de sala de cómputo.
const NOTIF_KEY = 'ethykos_notifs_';
const SNAPSHOT_KEY = 'ethykos_snapshot_';

function getStoredSnapshot(studentId) {
    try { return JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY + studentId) || 'null'); } catch(e) { return null; }
}
function saveSnapshot(studentId, data) {
    try { sessionStorage.setItem(SNAPSHOT_KEY + studentId, JSON.stringify(data)); } catch(e) {}
}
function getStoredNotifs(studentId) {
    try { return JSON.parse(sessionStorage.getItem(NOTIF_KEY + studentId) || '[]'); } catch(e) { return []; }
}
function saveNotifs(studentId, notifs) {
    try { sessionStorage.setItem(NOTIF_KEY + studentId, JSON.stringify(notifs.slice(0, 30))); } catch(e) {}
}

function generateNotifs(studentId, prev, current, prevTribePts, currentTribePts) {
    const notifs = getStoredNotifs(studentId);
    const now = new Date().toISOString();

    // Level up
    if (prev && current.individualPoints > prev.individualPoints) {
        const prevLvl = getLevelInfo(prev.individualPoints);
        const curLvl = getLevelInfo(current.individualPoints);
        if (curLvl.levelNumber > prevLvl.levelNumber) {
            notifs.unshift({ id: Date.now()+'_lvl', icon:'⬆️', title:`¡Subiste a ${curLvl.name}!`, sub:`Ahora eres ${curLvl.icon} ${curLvl.name}`, time: now, read: false });
        }
        const gained = current.individualPoints - prev.individualPoints;
        notifs.unshift({ id: Date.now()+'_pts', icon:'⭐', title:`+${gained} puntos de nivel`, sub:`Total: ${current.individualPoints} pts`, time: now, read: false });
    }

    // Reward points gained
    if (prev && current.rewardPoints > prev.rewardPoints) {
        const gained = current.rewardPoints - prev.rewardPoints;
        notifs.unshift({ id: Date.now()+'_rp', icon:'🪙', title:`+${gained} monedas recibidas`, sub:`Saldo actual: ${current.rewardPoints} 🪙`, time: now, read: false });
    }

    // Reward redeemed
    if (prev && current.rewardPoints < prev.rewardPoints) {
        const spent = prev.rewardPoints - current.rewardPoints;
        notifs.unshift({ id: Date.now()+'_red', icon:'🎁', title:`Canje realizado (-${spent} 🪙)`, sub:`Saldo actual: ${current.rewardPoints} 🪙`, time: now, read: false });
    }

    // Tribe points gained
    if (prevTribePts !== null && currentTribePts > prevTribePts) {
        const gained = currentTribePts - prevTribePts;
        notifs.unshift({ id: Date.now()+'_tri', icon:'🏆', title:`Tu tribu ganó ${gained} punto${gained!==1?'s':''}`, sub:`Puntuación de tribu: ${currentTribePts}`, time: now, read: false });
    }

    saveNotifs(studentId, notifs);
    return notifs;
}

function renderNotifPanel(notifs) {
    const list = document.getElementById('notifList');
    const badge = document.getElementById('notifBadge');
    const unread = notifs.filter(n => !n.read).length;

    if (unread > 0) {
        badge.style.display = 'flex';
        badge.textContent = unread > 9 ? '9+' : unread;
    } else {
        badge.style.display = 'none';
    }

    if (!notifs.length) {
        list.innerHTML = '<div class="notif-empty">Sin notificaciones</div>';
        return;
    }
    list.innerHTML = notifs.slice(0,20).map(n => {
        const d = new Date(n.time);
        const timeStr = `${d.getDate()}/${d.getMonth()+1} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        return `<div class="notif-item ${n.read?'':'unread'}">
            <div class="notif-item-icon">${n.icon}</div>
            <div class="notif-item-body">
                <div class="notif-item-title">${escHtml(n.title)}</div>
                <div class="notif-item-sub">${escHtml(n.sub)}</div>
                <div class="notif-item-time">${timeStr}</div>
            </div>
        </div>`;
    }).join('');
}

window.toggleNotifPanel = function() {
    const panel = document.getElementById('notifPanel');
    panel.classList.toggle('open');
};

window.clearNotifs = function() {
    if (!currentStudent) return;
    const notifs = getStoredNotifs(currentStudent.id).map(n => ({...n, read: true}));
    saveNotifs(currentStudent.id, notifs);
    renderNotifPanel(notifs);
    document.getElementById('notifBadge').style.display = 'none';
    document.getElementById('notifPanel').classList.remove('open');
};

// Close panel on outside click
document.addEventListener('click', e => {
    const panel = document.getElementById('notifPanel');
    const btn = document.getElementById('notifBtn');
    if (panel && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        panel.classList.remove('open');
    }
});

// ── UTILS ────────────────────────────────────────────────────
function getLevelInfo(points) {
    const pts = points || 0;
    let idx = 0;
    ETHICS_LEVELS.forEach((l, i) => { if (pts >= l.min) idx = i; });
    const cur = ETHICS_LEVELS[idx];
    const nxt = ETHICS_LEVELS[idx + 1] || null;
    const pct = nxt ? Math.min(100, Math.round(((pts - cur.min) / (nxt.min - cur.min)) * 100)) : 100;
    return { levelNumber: idx+1, name: cur.name, icon: cur.icon, points: pts, nextName: nxt?.name||null, nextMin: nxt?.min||null, pctToNext: pct };
}
function escHtml(t) {
    const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML;
}
function toast(msg, type='') {
    const w = document.getElementById('toastWrap');
    const el = document.createElement('div');
    el.className = 'toast-msg' + (type==='ok' ? ' ok' : '');
    el.textContent = msg;
    w.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}
function show(id) { document.getElementById(id).style.display=''; }
function hide(id) { document.getElementById(id).style.display='none'; }

// ── BOOT ─────────────────────────────────────────────────────
function toggleDarkMode() {
    const isDark = document.body.classList.toggle('dark');
    localStorage.setItem('ethykos_darkMode', isDark ? '1' : '0');
    const btn = document.getElementById('darkModeBtnStudent');
    if (btn) btn.textContent = isDark ? '🌞' : '🌙';
}
// Restaurar preferencia guardada
(function() {
    if (localStorage.getItem('ethykos_darkMode') === '1') {
        document.body.classList.add('dark');
        const btn = document.getElementById('darkModeBtnStudent');
        if (btn) btn.textContent = '🌞';
    }
})();

async function boot() {
    // Espera la autenticación anónima antes de cualquier lectura a Firestore.
    await authReady;
    // Siempre se pide el documento: no se restaura ninguna sesión anterior
    // (equipos compartidos en sala de cómputo).
    hide('loadingScreen'); show('loginScreen');
    document.getElementById('docInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
}

async function findStudent(docNumber) {
    const q = query(collection(db, 'students'), where('document', '==', String(docNumber)));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// ── LOGIN ─────────────────────────────────────────────────────
window.doLogin = async function() {
    const doc_ = document.getElementById('docInput').value.trim();
    const errEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');
    errEl.style.display = 'none';
    if (!doc_) { errEl.textContent = 'Ingresa tu número de documento'; errEl.style.display='block'; return; }
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Buscando...';
    try {
        const student = await findStudent(doc_);
        if (!student) {
            errEl.textContent = '❌ Documento no encontrado. Verifica el número o consulta a tu profe.';
            errEl.style.display = 'block';
        } else {
            currentStudent = student;
            await renderPortal();
        }
    } catch(e) {
        errEl.textContent = 'Error de conexión. Intenta de nuevo.';
        errEl.style.display = 'block';
    } finally {
        btn.disabled = false; btn.innerHTML = '<i class="fas fa-arrow-right"></i> Ingresar';
    }
};

window.doLogout = function() {
    // Limpia también snapshot/notificaciones en sessionStorage del estudiante actual,
    // para no dejar rastro en el equipo compartido.
    try {
        if (currentStudent?.id) {
            sessionStorage.removeItem(SNAPSHOT_KEY + currentStudent.id);
            sessionStorage.removeItem(NOTIF_KEY + currentStudent.id);
        }
    } catch(e) {}
    currentStudent = null;
    hide('portalScreen'); show('loginScreen');
    document.getElementById('docInput').value = '';
};

// ── RENDER PORTAL ─────────────────────────────────────────────
async function renderPortal() {
    hide('loadingScreen'); hide('loginScreen'); show('portalScreen');
    const s = currentStudent;
    const lvl = getLevelInfo(s.individualPoints);
    const rp = s.rewardPoints || 0;

    // Header
    document.getElementById('headerName').textContent = s.name.split(' ')[0];

    // Hero
    document.getElementById('heroAvatar').textContent = lvl.icon;
    document.getElementById('heroName').textContent = s.name;
    document.getElementById('heroMeta').textContent =
        `${COURSE_NAMES[s.course]||s.course} · Doc. ${s.document||''}`;
    document.getElementById('levelLabel').textContent =
        `Nivel ${lvl.levelNumber} · ${lvl.name}`;
    const ptsToNext = lvl.nextMin ? lvl.nextMin - lvl.points : 0;
    document.getElementById('levelPcts').textContent =
        lvl.nextName ? `${lvl.pctToNext}% · faltan ${ptsToNext} pts` : '¡Nivel máximo!';
    document.getElementById('levelBar').style.width = lvl.pctToNext + '%';
    document.getElementById('levelBadge').textContent = `${lvl.icon} ${lvl.name}`;

    // Mensaje motivador y descripción del nivel actual
    const currentLevelData = ETHICS_LEVELS.find(l => l.name === lvl.name);
    const motivEl = document.getElementById('motivMsg');
    const descEl = document.getElementById('levelDesc');
    if (motivEl) motivEl.textContent = getMotivMessage(lvl, ptsToNext);
    if (descEl && currentLevelData) {
        descEl.textContent = currentLevelData.desc +
            (currentLevelData.nextHint ? ' · ' + currentLevelData.nextHint : '');
    }

    // Stats
    document.getElementById('statLevel').textContent = lvl.levelNumber;
    document.getElementById('statPts').textContent = lvl.points;
    document.getElementById('statCoins').textContent = rp;

    // Levels journey
    renderLevelsJourney(lvl.levelNumber, lvl.points);

    // Rewards
    renderRewardsGrid(rp);

    // Load async data + notifications
    const prevSnapshot = getStoredSnapshot(s.id);
    const [tribeResult] = await Promise.all([
        loadTribeData(),
        loadAttendance()
    ]);

    // Actualización automática de datos de tribu cada 45s
    if (!window.__tribeRefreshInterval) {
        window.__tribeRefreshInterval = setInterval(loadTribeData, 45000);
    }

    // Generate and show notifications based on snapshot diff
    const notifs = generateNotifs(
        s.id,
        prevSnapshot?.student || null,
        s,
        prevSnapshot?.tribePts ?? null,
        tribeResult?.points ?? null
    );
    renderNotifPanel(notifs);

    // Save new snapshot
    saveSnapshot(s.id, { student: { individualPoints: s.individualPoints, rewardPoints: s.rewardPoints }, tribePts: tribeResult?.points ?? null });
}

function renderLevelsJourney(currentLevelNum, pts) {
    const container = document.getElementById('levelsJourney');
    container.innerHTML = ETHICS_LEVELS.map((lvl, i) => {
        const num = i + 1;
        const next = ETHICS_LEVELS[i+1];
        const isAchieved = num < currentLevelNum;
        const isCurrent = num === currentLevelNum;
        const isLocked = num > currentLevelNum;
        const cls = isCurrent ? 'current' : isAchieved ? 'achieved' : 'locked';
        const badge = isCurrent ? '<span class="level-step-badge badge-current">← Estás aquí</span>'
            : isAchieved ? '<span class="level-step-badge badge-achieved">✓ Logrado</span>'
            : '<span class="level-step-badge badge-locked">🔒 Bloqueado</span>';
        const ptsText = next ? `${lvl.min} pts para alcanzarlo · ${next.min - lvl.min} pts de rango` : `Desde ${lvl.min} pts · Nivel máximo`;
        const faltanText = isLocked ? `<div style="font-size:11px;color:#94A3B8;margin-top:2px;">Faltan ${lvl.min - pts} pts para desbloquearlo</div>` : '';
        const descText = lvl.desc ? `<div style="font-size:11px;color:#64748B;margin-top:3px;font-style:italic;">${lvl.desc}</div>` : '';
        return `<div class="level-step ${cls}">
            <div class="level-step-icon">${lvl.icon}</div>
            <div class="level-step-info">
                <div class="level-step-name">Nivel ${num} · ${lvl.name}</div>
                <div class="level-step-pts">${ptsText}</div>
                ${descText}
                ${faltanText}
            </div>
            ${badge}
        </div>`;
    }).join('');
}

function renderRewardsGrid(balance) {
    const grid = document.getElementById('rewardsGrid');
    grid.innerHTML = REWARDS.map(r => {
        const can = balance >= r.cost;
        return `<div class="reward-card-student ${can?'':'locked'}">
            <div class="rc-icon">${r.icon}</div>
            <div class="rc-name">${r.name}</div>
            <div class="rc-cost">🪙 ${r.cost} monedas</div>
            <span class="rc-status ${can?'can':'cant'}">${can?'✓ Puedes canjearlo':'Monedas insuficientes'}</span>
        </div>`;
    }).join('');
}

async function loadTribeData() {
    try {
        const snap = await getDocs(collection(db, 'tribes'));
        let myTribe = null;
        snap.forEach(d => {
            const t = { id: d.id, ...d.data() };
            if ((t.members||[]).some(m => m.studentId === currentStudent.id || m.name === currentStudent.name)) {
                myTribe = t;
            }
        });
        if (!myTribe) return { points: null };

        // Hero tribe chip
        document.getElementById('heroTribeName').textContent = myTribe.name;
        document.getElementById('heroTribe').style.display = 'inline-flex';

        // Tribe section
        document.getElementById('tribeSection').style.display = '';

        // Emblem
        const emblemWrap = document.getElementById('tribeEmblem');
        emblemWrap.innerHTML = myTribe.imageData
            ? `<img src="${myTribe.imageData}" alt="${escHtml(myTribe.name)}">`
            : `<div class="no-img">🛡️</div>`;

        document.getElementById('tribeDetailName').textContent = myTribe.name;
        document.getElementById('tribeDetailCry').textContent = myTribe.warCry ? `"${myTribe.warCry}"` : '';
        document.getElementById('tribeScore').textContent = myTribe.points || 0;

        // Members
        const membersList = document.getElementById('tribeMembersList');
        membersList.innerHTML = (myTribe.members || []).map(m => {
            const isMe = m.studentId === currentStudent.id || m.name === currentStudent.name;
            return `<div class="tribe-member-chip ${isMe?'me':''}">
                ${isMe ? '👤 ' : ''}${escHtml(m.name)}
                <span class="member-role-tag">${escHtml(m.role)}</span>
            </div>`;
        }).join('');
    } catch(e) { console.error('Error loading tribe:', e); }
}


async function loadAttendance() {
    try {
        const q = query(collection(db, 'attendance'), where('studentDoc', '==', String(currentStudent.document)));
        const snap = await getDocs(q);
        const list = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() }));
        list.sort((a,b) => (b.date||'').localeCompare(a.date||''));

        const container = document.getElementById('attList');
        if (!list.length) {
            container.innerHTML = '<div class="att-empty">📭 Sin registros de asistencia aún</div>';
            return;
        }
        container.innerHTML = list.map(r =>
            `<div class="att-row">
                <span class="att-d">📅 ${r.date}</span>
                <span class="att-t">✅ Asistió${r.tribeName?' · +1pt a '+escHtml(r.tribeName):''}</span>
            </div>`
        ).join('');
    } catch(e) { console.error('Error loading attendance:', e); }
}

// ── START ────────────────────────────────────────────────────
boot();

/* === BLOQUE 2 === */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import { getFirestore, collection, getDocs, query, where, orderBy } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";

const app = initializeApp(window.firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Autenticación anónima e invisible para el estudiante: no pide nada,
// solo permite que las reglas de Firestore exijan "request.auth != null"
// y así bloqueen lecturas que no pasen por esta aplicación.
let authReady = signInAnonymously(auth).catch(err => {
    console.error('No se pudo iniciar sesión anónima:', err);
});

// ── CONSTANTS ───────────────────────────────────────────────
const ETHICS_LEVELS = [
    { min: 0,   name: "Aprendiz",         icon: "🌱" },
    { min: 50,  name: "Curioso/a",        icon: "🔍" },
    { min: 120, name: "Reflexivo/a",      icon: "💭" },
    { min: 220, name: "Comprometido/a",   icon: "🤝" },
    { min: 350, name: "Ético/a Activo/a", icon: "🔥" },
    { min: 500, name: "Guía Ética",       icon: "🌟" }
];
let REWARDS = [];
let rewardsCatalogLoaded = false;
async function loadRewardsCatalog() {
    if (rewardsCatalogLoaded) return REWARDS;
    try {
        const snap = await getDocs(collection(db, 'rewards'));
        REWARDS = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (a.cost||0)-(b.cost||0));
        rewardsCatalogLoaded = true;
    } catch(e) { console.error('Error cargando catálogo de recompensas', e); }
    return REWARDS;
}
const COURSE_NAMES = { 6:'6°', 7:'7°', 8:'8°', 9:'9°', 10:'10°', 11:'11°' };

// ── SESSION ──────────────────────────────────────────────────
// NOTA DE SEGURIDAD: esta app se usa en equipos compartidos (sala de
// cómputo). Por eso NO se guarda ni se restaura sesión entre cargas de
// página: cada vez que se abre/recarga Student.html, el estudiante debe
// ingresar su documento de nuevo. No usar localStorage aquí.
let currentStudent = null;

// ── NOTIFICATIONS ────────────────────────────────────────────
// sessionStorage: se borra automáticamente al cerrar la pestaña/navegador,
// para no dejar datos de un estudiante disponibles al siguiente en un
// equipo compartido de sala de cómputo.
const NOTIF_KEY = 'ethykos_notifs_';
const SNAPSHOT_KEY = 'ethykos_snapshot_';

function getStoredSnapshot(studentId) {
    try { return JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY + studentId) || 'null'); } catch(e) { return null; }
}
function saveSnapshot(studentId, data) {
    try { sessionStorage.setItem(SNAPSHOT_KEY + studentId, JSON.stringify(data)); } catch(e) {}
}
function getStoredNotifs(studentId) {
    try { return JSON.parse(sessionStorage.getItem(NOTIF_KEY + studentId) || '[]'); } catch(e) { return []; }
}
function saveNotifs(studentId, notifs) {
    try { sessionStorage.setItem(NOTIF_KEY + studentId, JSON.stringify(notifs.slice(0, 30))); } catch(e) {}
}

function generateNotifs(studentId, prev, current, prevTribePts, currentTribePts) {
    const notifs = getStoredNotifs(studentId);
    const now = new Date().toISOString();

    // Level up
    if (prev && current.individualPoints > prev.individualPoints) {
        const prevLvl = getLevelInfo(prev.individualPoints);
        const curLvl = getLevelInfo(current.individualPoints);
        if (curLvl.levelNumber > prevLvl.levelNumber) {
            notifs.unshift({ id: Date.now()+'_lvl', icon:'⬆️', title:`¡Subiste a ${curLvl.name}!`, sub:`Ahora eres ${curLvl.icon} ${curLvl.name}`, time: now, read: false });
        }
        const gained = current.individualPoints - prev.individualPoints;
        notifs.unshift({ id: Date.now()+'_pts', icon:'⭐', title:`+${gained} puntos de nivel`, sub:`Total: ${current.individualPoints} pts`, time: now, read: false });
    }

    // Reward points gained
    if (prev && current.rewardPoints > prev.rewardPoints) {
        const gained = current.rewardPoints - prev.rewardPoints;
        notifs.unshift({ id: Date.now()+'_rp', icon:'🪙', title:`+${gained} monedas recibidas`, sub:`Saldo actual: ${current.rewardPoints} 🪙`, time: now, read: false });
    }

    // Reward redeemed
    if (prev && current.rewardPoints < prev.rewardPoints) {
        const spent = prev.rewardPoints - current.rewardPoints;
        notifs.unshift({ id: Date.now()+'_red', icon:'🎁', title:`Canje realizado (-${spent} 🪙)`, sub:`Saldo actual: ${current.rewardPoints} 🪙`, time: now, read: false });
    }

    // Tribe points gained
    if (prevTribePts !== null && currentTribePts > prevTribePts) {
        const gained = currentTribePts - prevTribePts;
        notifs.unshift({ id: Date.now()+'_tri', icon:'🏆', title:`Tu tribu ganó ${gained} punto${gained!==1?'s':''}`, sub:`Puntuación de tribu: ${currentTribePts}`, time: now, read: false });
    }

    saveNotifs(studentId, notifs);
    return notifs;
}

function renderNotifPanel(notifs) {
    const list = document.getElementById('notifList');
    const badge = document.getElementById('notifBadge');
    const unread = notifs.filter(n => !n.read).length;

    if (unread > 0) {
        badge.style.display = 'flex';
        badge.textContent = unread > 9 ? '9+' : unread;
    } else {
        badge.style.display = 'none';
    }

    if (!notifs.length) {
        list.innerHTML = '<div class="notif-empty">Sin notificaciones</div>';
        return;
    }
    list.innerHTML = notifs.slice(0,20).map(n => {
        const d = new Date(n.time);
        const timeStr = `${d.getDate()}/${d.getMonth()+1} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        return `<div class="notif-item ${n.read?'':'unread'}">
            <div class="notif-item-icon">${n.icon}</div>
            <div class="notif-item-body">
                <div class="notif-item-title">${escHtml(n.title)}</div>
                <div class="notif-item-sub">${escHtml(n.sub)}</div>
                <div class="notif-item-time">${timeStr}</div>
            </div>
        </div>`;
    }).join('');
}

window.toggleNotifPanel = function() {
    const panel = document.getElementById('notifPanel');
    panel.classList.toggle('open');
};

window.clearNotifs = function() {
    if (!currentStudent) return;
    const notifs = getStoredNotifs(currentStudent.id).map(n => ({...n, read: true}));
    saveNotifs(currentStudent.id, notifs);
    renderNotifPanel(notifs);
    document.getElementById('notifBadge').style.display = 'none';
    document.getElementById('notifPanel').classList.remove('open');
};

// Close panel on outside click
document.addEventListener('click', e => {
    const panel = document.getElementById('notifPanel');
    const btn = document.getElementById('notifBtn');
    if (panel && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        panel.classList.remove('open');
    }
});

// ── UTILS ────────────────────────────────────────────────────
function getLevelInfo(points) {
    const pts = points || 0;
    let idx = 0;
    ETHICS_LEVELS.forEach((l, i) => { if (pts >= l.min) idx = i; });
    const cur = ETHICS_LEVELS[idx];
    const nxt = ETHICS_LEVELS[idx + 1] || null;
    const pct = nxt ? Math.min(100, Math.round(((pts - cur.min) / (nxt.min - cur.min)) * 100)) : 100;
    return { levelNumber: idx+1, name: cur.name, icon: cur.icon, points: pts, nextName: nxt?.name||null, nextMin: nxt?.min||null, pctToNext: pct };
}
function escHtml(t) {
    const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML;
}
function toast(msg, type='') {
    const w = document.getElementById('toastWrap');
    const el = document.createElement('div');
    el.className = 'toast-msg' + (type==='ok' ? ' ok' : '');
    el.textContent = msg;
    w.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}
function show(id) { document.getElementById(id).style.display=''; }
function hide(id) { document.getElementById(id).style.display='none'; }

// ── BOOT ─────────────────────────────────────────────────────
async function boot() {
    // Espera la autenticación anónima antes de cualquier lectura a Firestore.
    await authReady;
    // Se carga en paralelo mientras el estudiante escribe su documento (no bloquea el login).
    loadRewardsCatalog();
    // Siempre se pide el documento: no se restaura ninguna sesión anterior
    // (equipos compartidos en sala de cómputo).
    hide('loadingScreen'); show('loginScreen');
    document.getElementById('docInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
}

async function findStudent(docNumber) {
    const q = query(collection(db, 'students'), where('document', '==', String(docNumber)));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// ── LOGIN ─────────────────────────────────────────────────────
window.doLogin = async function() {
    const doc_ = document.getElementById('docInput').value.trim();
    const errEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');
    errEl.style.display = 'none';
    if (!doc_) { errEl.textContent = 'Ingresa tu número de documento'; errEl.style.display='block'; return; }
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Buscando...';
    try {
        const student = await findStudent(doc_);
        if (!student) {
            errEl.textContent = '❌ Documento no encontrado. Verifica el número o consulta a tu profe.';
            errEl.style.display = 'block';
        } else {
            currentStudent = student;
            await renderPortal();
        }
    } catch(e) {
        errEl.textContent = 'Error de conexión. Intenta de nuevo.';
        errEl.style.display = 'block';
    } finally {
        btn.disabled = false; btn.innerHTML = '<i class="fas fa-arrow-right"></i> Ingresar';
    }
};

window.doLogout = function() {
    // Limpia también snapshot/notificaciones en sessionStorage del estudiante actual,
    // para no dejar rastro en el equipo compartido.
    try {
        if (currentStudent?.id) {
            sessionStorage.removeItem(SNAPSHOT_KEY + currentStudent.id);
            sessionStorage.removeItem(NOTIF_KEY + currentStudent.id);
        }
    } catch(e) {}
    currentStudent = null;
    hide('portalScreen'); show('loginScreen');
    document.getElementById('docInput').value = '';
};

// ── RENDER PORTAL ─────────────────────────────────────────────
async function renderPortal() {
    hide('loadingScreen'); hide('loginScreen'); show('portalScreen');
    const s = currentStudent;
    const lvl = getLevelInfo(s.individualPoints);
    const rp = s.rewardPoints || 0;

    // Header
    document.getElementById('headerName').textContent = s.name.split(' ')[0];

    // Hero
    document.getElementById('heroAvatar').textContent = lvl.icon;
    document.getElementById('heroName').textContent = s.name;
    document.getElementById('heroMeta').textContent =
        `${COURSE_NAMES[s.course]||s.course} · Doc. ${s.document||''}`;
    document.getElementById('levelLabel').textContent =
        `Nivel ${lvl.levelNumber} · ${lvl.name}`;
    const ptsToNext = lvl.nextMin ? lvl.nextMin - lvl.points : 0;
    document.getElementById('levelPcts').textContent =
        lvl.nextName ? `${lvl.pctToNext}% · faltan ${ptsToNext} pts` : '¡Nivel máximo!';
    document.getElementById('levelBar').style.width = lvl.pctToNext + '%';
    document.getElementById('levelBadge').textContent = `${lvl.icon} ${lvl.name}`;

    // Mensaje motivador y descripción del nivel actual
    const currentLevelData = ETHICS_LEVELS.find(l => l.name === lvl.name);
    const motivEl = document.getElementById('motivMsg');
    const descEl = document.getElementById('levelDesc');
    if (motivEl) motivEl.textContent = getMotivMessage(lvl, ptsToNext);
    if (descEl && currentLevelData) {
        descEl.textContent = currentLevelData.desc +
            (currentLevelData.nextHint ? ' · ' + currentLevelData.nextHint : '');
    }

    // Stats
    document.getElementById('statLevel').textContent = lvl.levelNumber;
    document.getElementById('statPts').textContent = lvl.points;
    document.getElementById('statCoins').textContent = rp;

    // Levels journey
    renderLevelsJourney(lvl.levelNumber, lvl.points);

    // Rewards
    await loadRewardsCatalog();
    renderRewardsGrid(rp);

    // Load async data + notifications
    const prevSnapshot = getStoredSnapshot(s.id);
    const [tribeResult] = await Promise.all([
        loadTribeData(),
        loadAttendance()
    ]);

    // Generate and show notifications based on snapshot diff
    const notifs = generateNotifs(
        s.id,
        prevSnapshot?.student || null,
        s,
        prevSnapshot?.tribePts ?? null,
        tribeResult?.points ?? null
    );
    renderNotifPanel(notifs);

    // Save new snapshot
    saveSnapshot(s.id, { student: { individualPoints: s.individualPoints, rewardPoints: s.rewardPoints }, tribePts: tribeResult?.points ?? null });
}

function renderLevelsJourney(currentLevelNum, pts) {
    const container = document.getElementById('levelsJourney');
    container.innerHTML = ETHICS_LEVELS.map((lvl, i) => {
        const num = i + 1;
        const next = ETHICS_LEVELS[i+1];
        const isAchieved = num < currentLevelNum;
        const isCurrent = num === currentLevelNum;
        const isLocked = num > currentLevelNum;
        const cls = isCurrent ? 'current' : isAchieved ? 'achieved' : 'locked';
        const badge = isCurrent ? '<span class="level-step-badge badge-current">← Estás aquí</span>'
            : isAchieved ? '<span class="level-step-badge badge-achieved">✓ Logrado</span>'
            : '<span class="level-step-badge badge-locked">🔒 Bloqueado</span>';
        const ptsText = next ? `${lvl.min} pts para alcanzarlo · ${next.min - lvl.min} pts de rango` : `Desde ${lvl.min} pts · Nivel máximo`;
        const faltanText = isLocked ? `<div style="font-size:11px;color:#94A3B8;margin-top:2px;">Faltan ${lvl.min - pts} pts para desbloquearlo</div>` : '';
        const descText = lvl.desc ? `<div style="font-size:11px;color:#64748B;margin-top:3px;font-style:italic;">${lvl.desc}</div>` : '';
        return `<div class="level-step ${cls}">
            <div class="level-step-icon">${lvl.icon}</div>
            <div class="level-step-info">
                <div class="level-step-name">Nivel ${num} · ${lvl.name}</div>
                <div class="level-step-pts">${ptsText}</div>
                ${descText}
                ${faltanText}
            </div>
            ${badge}
        </div>`;
    }).join('');
}

function renderRewardsGrid(balance) {
    const grid = document.getElementById('rewardsGrid');
    grid.innerHTML = REWARDS.map(r => {
        const can = balance >= r.cost;
        return `<div class="reward-card-student ${can?'':'locked'}">
            <div class="rc-icon">${r.icon}</div>
            <div class="rc-name">${r.name}</div>
            <div class="rc-cost">🪙 ${r.cost} monedas</div>
            <span class="rc-status ${can?'can':'cant'}">${can?'✓ Puedes canjearlo':'Monedas insuficientes'}</span>
        </div>`;
    }).join('');
}

async function loadTribeData() {
    try {
        const snap = await getDocs(collection(db, 'tribes'));
        let myTribe = null;
        snap.forEach(d => {
            const t = { id: d.id, ...d.data() };
            if ((t.members||[]).some(m => m.studentId === currentStudent.id || m.name === currentStudent.name)) {
                myTribe = t;
            }
        });
        if (!myTribe) return { points: null };

        // Hero tribe chip
        document.getElementById('heroTribeName').textContent = myTribe.name;
        document.getElementById('heroTribe').style.display = 'inline-flex';

        // Tribe section
        document.getElementById('tribeSection').style.display = '';

        // Emblem
        const emblemWrap = document.getElementById('tribeEmblem');
        emblemWrap.innerHTML = myTribe.imageData
            ? `<img src="${myTribe.imageData}" alt="${escHtml(myTribe.name)}">`
            : `<div class="no-img">🛡️</div>`;

        document.getElementById('tribeDetailName').textContent = myTribe.name;
        document.getElementById('tribeDetailCry').textContent = myTribe.warCry ? `"${myTribe.warCry}"` : '';
        document.getElementById('tribeScore').textContent = myTribe.points || 0;

        // Members
        const membersList = document.getElementById('tribeMembersList');
        membersList.innerHTML = (myTribe.members || []).map(m => {
            const isMe = m.studentId === currentStudent.id || m.name === currentStudent.name;
            return `<div class="tribe-member-chip ${isMe?'me':''}">
                ${isMe ? '👤 ' : ''}${escHtml(m.name)}
                <span class="member-role-tag">${escHtml(m.role)}</span>
            </div>`;
        }).join('');
    } catch(e) { console.error('Error loading tribe:', e); }
}


async function loadAttendance() {
    try {
        const q = query(collection(db, 'attendance'), where('studentDoc', '==', String(currentStudent.document)));
        const snap = await getDocs(q);
        const list = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() }));
        list.sort((a,b) => (b.date||'').localeCompare(a.date||''));

        const container = document.getElementById('attList');
        if (!list.length) {
            container.innerHTML = '<div class="att-empty">📭 Sin registros de asistencia aún</div>';
            return;
        }
        container.innerHTML = list.map(r =>
            `<div class="att-row">
                <span class="att-d">📅 ${r.date}</span>
                <span class="att-t">✅ Asistió${r.tribeName?' · +1pt a '+escHtml(r.tribeName):''}</span>
            </div>`
        ).join('');
    } catch(e) { console.error('Error loading attendance:', e); }
}

// ── START ────────────────────────────────────────────────────
boot();
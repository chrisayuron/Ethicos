import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
    import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";
    import { getFirestore, collection, doc, getDoc, getDocs, updateDoc, deleteDoc, addDoc, setDoc, query, where, serverTimestamp, orderBy } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";

    const app = initializeApp(window.firebaseConfig);
    const auth = getAuth(app);
    const db = getFirestore(app);

    const courseNames = { 6:"6°", 7:"7°", 8:"8°", 9:"9°", 10:"10°", 11:"11°" };
    const rolesDisponibles = ["Líder","Comunicador","Artesano","Guardián","Explorador","Guerrero"];
    let currentGrade = 6;
    let editingTribeId = null;
    let tempImageData = null;
    let csvParsedData = [];
    let qrStream = null;
    let qrScanInterval = null;
    let scannedToday = new Set();
    let assigningStudent = null;

    // ===== CACHE DE DATOS (evita lecturas excesivas a Firestore) =====
    // Todas las lecturas pasan por la caché. Solo se lee Firestore al iniciar o al sincronizar.
    const CACHE_KEY = 'ethykos_dataCache';
    const CACHE_TTL = 10 * 60 * 1000; // 10 minutos: después de esto se considera obsoleta
    let dataCache = {
        tribes: [],
        students: [],
        attendance: [],
        lastSync: 0
    };

    function saveCacheToLocal() {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(dataCache));
        } catch(e) {}
    }
    function loadCacheFromLocal() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.tribes && parsed.students) {
                    dataCache = parsed;
                    return true;
                }
            }
        } catch(e) {}
        return false;
    }
    function isCacheStale() {
        return (Date.now() - (dataCache.lastSync || 0)) > CACHE_TTL;
    }

    // Carga TODO desde Firestore una sola vez (al inicio o al sincronizar)
    async function loadAllData(forceFresh) {
        if (!forceFresh && loadCacheFromLocal() && !isCacheStale()) {
            return; // Caché local todavía es válida
        }
        const [tribesSnap, studentsSnap, attSnap] = await Promise.all([
            getDocs(collection(db, "tribes")),
            getDocs(collection(db, "students")),
            getDocs(collection(db, "attendance"))
        ]);
        dataCache.tribes = [];
        tribesSnap.forEach(d => dataCache.tribes.push({ id: d.id, ...d.data() }));
        dataCache.students = [];
        studentsSnap.forEach(d => dataCache.students.push({ id: d.id, ...d.data() }));
        dataCache.attendance = [];
        attSnap.forEach(d => dataCache.attendance.push({ id: d.id, ...d.data() }));
        dataCache.lastSync = Date.now();
        saveCacheToLocal();
    }

    // Nota: cada función cacheAdd*/cacheUpdate*/cacheDelete* de más abajo ya actualiza
    // localStorage Y Firestore directamente (escritura real vía updateDoc/addDoc/deleteDoc
    // en el punto donde se usa). No existe una cola de sincronización diferida: todo cambio
    // se escribe de inmediato a Firestore, el caché local solo evita tener que releerlo.

    // Lecturas desde caché (reemplazan getTribes y getStudents)
    function getCachedTribes(grade) {
        if (grade !== undefined && grade !== null) {
            return dataCache.tribes.filter(t => {
                const tGrade = t.grade !== undefined ? String(t.grade).trim() : null;
                const tCourse = t.course !== undefined ? String(t.course).trim() : null;
                const g = String(grade).trim();
                return tGrade === g || tCourse === g;
            }).sort((a, b) => a.name.localeCompare(b.name));
        }
        return [...dataCache.tribes].sort((a, b) => a.name.localeCompare(b.name));
    }
    function getCachedStudents(course) {
        if (course !== undefined && course !== null) {
            return dataCache.students.filter(s => String(s.course) === String(course))
                .sort((a, b) => a.name.localeCompare(b.name));
        }
        return [...dataCache.students].sort((a, b) => a.name.localeCompare(b.name));
    }
    function getCachedAttendance() {
        return dataCache.attendance;
    }

    // Helpers para modificar la caché local (la escritura real a Firestore ya sucede
    // en el punto donde se llama a cada uno de estos, antes o después según el caso)
    function cacheAddTribe(tribe) {
        dataCache.tribes.push(tribe);
        saveCacheToLocal();
    }
    function cacheUpdateTribe(id, data) {
        const idx = dataCache.tribes.findIndex(t => t.id === id);
        if (idx >= 0) Object.assign(dataCache.tribes[idx], data);
        saveCacheToLocal();
    }
    function cacheDeleteTribe(id) {
        dataCache.tribes = dataCache.tribes.filter(t => t.id !== id);
        saveCacheToLocal();
    }
    function cacheAddStudent(student) {
        dataCache.students.push(student);
        saveCacheToLocal();
    }
    function cacheDeleteStudent(id) {
        dataCache.students = dataCache.students.filter(s => s.id !== id);
        saveCacheToLocal();
    }
    function cacheUpdateStudent(id, data) {
        const idx = dataCache.students.findIndex(s => s.id === id);
        if (idx >= 0) Object.assign(dataCache.students[idx], data);
        saveCacheToLocal();
    }
    function cacheAddAttendance(record) {
        dataCache.attendance.push(record);
        saveCacheToLocal();
    }
    function cacheUpdateAttendance(id, data) {
        const idx = dataCache.attendance.findIndex(r => r.id === id);
        if (idx >= 0) Object.assign(dataCache.attendance[idx], data);
        saveCacheToLocal();
    }

    // Auto-reparación con debounce: se ejecuta después de cambios en tribus
    // para reparar asistencia huérfana sin intervención del usuario
    let repairTimeout = null;
    let repairRunning = false; // Lock: evita ejecuciones concurrentes
    let repairPending = false; // Cola: indica si hay una reparación pendiente
    function scheduleRepair() {
        if (repairRunning) { repairPending = true; return; } // Si ya está reparando, marcar como pendiente
        if (repairTimeout) clearTimeout(repairTimeout);
        repairTimeout = setTimeout(() => autoRepairAttendance(), 5000); // 5s debounce
    }

    // ===== UTILS =====
    /**
     * Buscador desplegable reutilizable.
     * Al hacer foco en el input muestra TODOS los ítems; al escribir, filtra.
     */
    function createSearchableSelect({ inputId, hiddenId, listId, items, getLabel, getValue, onSelect, emptyLabel }) {
        const input = document.getElementById(inputId);
        const hidden = document.getElementById(hiddenId);
        const list = document.getElementById(listId);
        let currentItems = items || [];

        function renderList(filterText) {
            const f = (filterText || '').toLowerCase().trim();
            const filtered = f ? currentItems.filter(it => getLabel(it).toLowerCase().includes(f)) : currentItems;
            if (!filtered.length) {
                list.innerHTML = `<div class="searchable-select-empty">Sin resultados</div>`;
            } else {
                list.innerHTML = filtered.slice(0, 200).map(it =>
                    `<div class="searchable-select-item" data-value="${escapeHtml(String(getValue(it)))}">${escapeHtml(getLabel(it))}</div>`
                ).join('');
            }
            list.style.display = 'block';
        }

        input.addEventListener('focus', () => renderList(input.value));
        input.addEventListener('input', () => { hidden.value = ''; renderList(input.value); });
        list.addEventListener('mousedown', (e) => {
            const item = e.target.closest('.searchable-select-item');
            if (!item) return;
            const val = item.dataset.value;
            const obj = currentItems.find(it => String(getValue(it)) === val);
            input.value = obj ? getLabel(obj) : '';
            hidden.value = val;
            list.style.display = 'none';
            onSelect(val, obj);
        });
        document.addEventListener('click', (e) => {
            if (e.target !== input && !list.contains(e.target)) list.style.display = 'none';
        });
        return {
            clear() { input.value = ''; hidden.value = ''; list.style.display = 'none'; onSelect('', null); },
            setItems(newItems) { currentItems = newItems || []; }
        };
    }

    function escapeHtml(t) {
        if (!t) return '';
        const d = document.createElement('div');
        d.textContent = t;
        return d.innerHTML;
    }
    function showToast(msg, type = '') {
        const c = document.getElementById('toastContainer');
        const t = document.createElement('div');
        t.className = `toast ${type}`;
        t.textContent = msg;
        c.appendChild(t);
        setTimeout(() => t.remove(), 3000);
    }
    function openModal(id) { document.getElementById(id).style.display = 'flex'; }
    function closeModal(id) { document.getElementById(id).style.display = 'none'; }

    // ===== AUTH =====
    const AUTHORIZED_EMAILS = ["rrnewball@gmail.com", "ronald.rojas@bethshalom.edu.co"];

    // --- Cierre de sesión por inactividad (30 min) ---
    const IDLE_LIMIT_MS = 30 * 60 * 1000;
    const LAST_ACTIVE_KEY = "ethykos_lastActive";
    function markActivity() { localStorage.setItem(LAST_ACTIVE_KEY, Date.now().toString()); }
    function isSessionExpired() {
        const last = parseInt(localStorage.getItem(LAST_ACTIVE_KEY) || "0", 10);
        return (Date.now() - last) > IDLE_LIMIT_MS;
    }
    function forceLogoutExpired() {
        signOut(auth).finally(() => { window.location.href = "index.html?expired=1"; });
    }
    ["click","keydown","mousemove","scroll","touchstart"].forEach(evt =>
        document.addEventListener(evt, markActivity, { passive: true })
    );
    // Revisa cada minuto si la sesión sigue vigente (cubre el caso de dejar la pestaña abierta)
    setInterval(() => { if (isSessionExpired()) forceLogoutExpired(); }, 60 * 1000);

    onAuthStateChanged(auth, (user) => {
        if (!user) { window.location.href = "index.html"; return; }
        if (!AUTHORIZED_EMAILS.includes(user.email)) {
            // Sesión colada (anónima u otra cuenta): cerrarla y mandar al login
            signOut(auth).finally(() => { window.location.href = "index.html"; });
            return;
        }
        if (isSessionExpired()) { forceLogoutExpired(); return; }
        markActivity();
        initDashboard();
    });

    // ===== TRIBES CRUD =====
    async function getTribes(grade) {
        // Legacy: ahora usa caché. Solo Firestore si se fuerza.
        return getCachedTribes(grade);
    }

    // Busca la tribu de un estudiante en caché (robusto: prueba grade y course, number y string)
    function findStudentTribe(studentId, studentName, studentCourse) {
        const course = String(studentCourse).trim();
        for (const t of dataCache.tribes) {
            // Verificar que la tribu pertenece al curso del estudiante
            const tGrade = t.grade !== undefined ? String(t.grade).trim() : null;
            const tCourse = t.course !== undefined ? String(t.course).trim() : null;
            if (tGrade !== course && tCourse !== course) continue;
            // Buscar al estudiante en los miembros
            const match = (t.members || []).find(m =>
                (m.studentId && studentId && m.studentId === studentId) ||
                (m.name && m.name === studentName)
            );
            if (match) return { id: t.id, name: t.name };
        }
        return null;
    }

    async function saveTribe(data, editId) {
        if (editId) { await updateDoc(doc(db, "tribes", editId), data); return editId; }
        else { const ref = await addDoc(collection(db, "tribes"), data); return ref.id; }
    }
    async function deleteTribe(id) { await deleteDoc(doc(db, "tribes", id)); }

    /**
     * Registra un cambio de puntos en el log de auditoría. No bloquea la UI
     * (no se espera el resultado en los puntos de llamada); si falla, solo
     * se registra en consola, nunca interrumpe la acción principal.
     */
    async function logPointsChange(type, targetId, targetName, delta, resultingValue, source) {
        try {
            await addDoc(collection(db, "pointsLog"), {
                type, targetId, targetName: targetName || '', delta, resultingValue,
                source: source || 'manual',
                actorEmail: auth.currentUser?.email || 'desconocido',
                timestamp: serverTimestamp()
            });
        } catch(e) { console.error('Error al registrar en pointsLog:', e); }
    }

    async function updatePoints(id, delta, source) {
        // Usar caché para evitar lectura a Firestore cada vez
        const tribe = dataCache.tribes.find(t => t.id === id);
        if (!tribe) return;
        const newPoints = Math.max(0, (tribe.points || 0) + delta);
        tribe.points = newPoints;
        saveCacheToLocal();
        await updateDoc(doc(db, "tribes", id), { points: newPoints });
        logPointsChange('tribe', id, tribe.name, delta, newPoints, source || 'manual');
    }
    async function updateMember(id, members) { await updateDoc(doc(db, "tribes", id), { members }); }

    // ===== STUDENTS CRUD =====
    async function getStudents(filterCourse) {
        // Legacy: ahora usa caché. Solo Firestore si se fuerza.
        return getCachedStudents(filterCourse);
    }
    async function saveStudent(data) {
        if (data.id) {
            await setDoc(doc(db, "students", data.id), data, { merge: true });
            cacheUpdateStudent(data.id, data);
            return data.id;
        } else {
            const ref = await addDoc(collection(db, "students"), data);
            cacheAddStudent({ id: ref.id, ...data });
            return ref.id;
        }
    }
    async function deleteStudent(id) {
        await deleteDoc(doc(db, "students", id));
        cacheDeleteStudent(id);
    }

    // ===== NIVELES TEMÁTICOS INDIVIDUALES =====
    const ethicsLevels = [
        { min: 0,   name: "Aprendiz",        icon: "🌱" },
        { min: 50,  name: "Curioso/a",       icon: "🔍" },
        { min: 120, name: "Reflexivo/a",     icon: "💭" },
        { min: 220, name: "Comprometido/a",  icon: "🤝" },
        { min: 350, name: "Ético/a Activo/a",icon: "🔥" },
        { min: 500, name: "Guía Ética",      icon: "🌟" }
    ];
    function getLevelInfo(points) {
        const pts = points || 0;
        let levelIdx = 0;
        for (let i = 0; i < ethicsLevels.length; i++) {
            if (pts >= ethicsLevels[i].min) levelIdx = i;
        }
        const current = ethicsLevels[levelIdx];
        const next = ethicsLevels[levelIdx + 1] || null;
        const pctToNext = next ? Math.min(100, Math.round(((pts - current.min) / (next.min - current.min)) * 100)) : 100;
        return {
            levelNumber: levelIdx + 1,
            name: current.name,
            icon: current.icon,
            points: pts,
            nextName: next ? next.name : null,
            nextMin: next ? next.min : null,
            pctToNext
        };
    }
    async function updateStudentPoints(studentId, delta) {
        // Usar caché para evitar lectura a Firestore cada vez
        const student = dataCache.students.find(s => s.id === studentId);
        if (!student) return null;
        const current = student.individualPoints || 0;
        const updated = Math.max(0, current + delta);
        student.individualPoints = updated;
        saveCacheToLocal();
        await updateDoc(doc(db, "students", studentId), { individualPoints: updated });
        logPointsChange('individual', studentId, student.name, delta, updated, 'backfill');
        return updated;
    }

    /**
     * Otorga puntos de NIVEL a un estudiante, y en el mismo movimiento otorga
     * monedas 🪙 equivalentes (espejo del mismo delta). Si el estudiante sube
     * de nivel como resultado, se agrega además un bono de monedas = nivel × 10
     * por cada nivel alcanzado (ej. llegar a nivel 3 = +30 monedas de bono).
     * No existe ningún mecanismo para gastar monedas y acelerar el nivel.
     */
    async function awardLevelPoints(studentId, delta, source) {
        const student = dataCache.students.find(s => s.id === studentId);
        if (!student) return null;

        const beforePoints = student.individualPoints || 0;
        const beforeLevel = getLevelInfo(beforePoints).levelNumber;

        const afterPoints = Math.max(0, beforePoints + delta);
        const afterLevel = getLevelInfo(afterPoints).levelNumber;

        const beforeCoins = student.rewardPoints || 0;
        let afterCoins = Math.max(0, beforeCoins + delta); // espejo: mismas monedas que puntos otorgados/restados

        let bonusCoins = 0;
        if (afterLevel > beforeLevel) {
            for (let lvl = beforeLevel + 1; lvl <= afterLevel; lvl++) bonusCoins += lvl * 10;
            afterCoins += bonusCoins;
        }

        student.individualPoints = afterPoints;
        student.rewardPoints = afterCoins;
        saveCacheToLocal();
        await updateDoc(doc(db, "students", studentId), { individualPoints: afterPoints, rewardPoints: afterCoins });
        logPointsChange('individual', studentId, student.name, delta, afterPoints, source || 'manual');
        if (afterCoins !== beforeCoins) {
            logPointsChange('coins', studentId, student.name, afterCoins - beforeCoins, afterCoins, (source || 'manual') + (bonusCoins ? '+level_bonus' : ''));
        }

        return {
            points: afterPoints,
            coins: afterCoins,
            leveledUp: afterLevel > beforeLevel,
            levelInfo: getLevelInfo(afterPoints),
            bonusCoins
        };
    }

    // ===== ATTENDANCE =====
    async function recordAttendance(studentDoc, studentName, tribeId, tribeName, course, studentId) {
        const today = new Date().toISOString().slice(0, 10);
        const key = `${studentDoc}_${today}`;
        if (scannedToday.has(key)) return { duplicate: true };
        scannedToday.add(key);
        const newRecord = {
            studentDoc, studentName, tribeId: tribeId||null, tribeName: tribeName||null,
            course: course||null, date: today, timestamp: serverTimestamp(),
            pointsAwarded: true, tribePointsAwarded: !!tribeId
        };
        const ref = await addDoc(collection(db, "attendance"), newRecord);
        cacheAddAttendance({ id: ref.id, ...newRecord });
        if (tribeId) await updatePoints(tribeId, 1, 'attendance');
        let awardResult = null;
        if (studentId) awardResult = await awardLevelPoints(studentId, 1, 'attendance');
        return { ok: true, tribeName, awardResult };
    }
    async function getTodayAttendance() {
        const today = new Date().toISOString().slice(0, 10);
        return dataCache.attendance.filter(r => r.date === today);
    }
    async function getAttendanceHistory(filters) {
        // filters: { studentDoc, dateFrom, dateTo, course }
        try {
            let list = getCachedAttendance();
            if (filters.studentDoc) {
                list = list.filter(r => r.studentDoc === filters.studentDoc);
            }
            if (filters.course) {
                list = list.filter(r => String(r.course) === String(filters.course));
            }
            if (filters.dateFrom) {
                list = list.filter(r => r.date >= filters.dateFrom);
            }
            if (filters.dateTo) {
                list = list.filter(r => r.date <= filters.dateTo);
            }
            return list.sort((a,b) => (b.date||'').localeCompare(a.date||'') || (b.timestamp?.seconds||0)-(a.timestamp?.seconds||0));
        } catch(e) { console.error('Error cargando historial:', e); return []; }
    }
    // ===== RENDER CHART =====
    async function renderChart() {
        const container = document.getElementById("chartContainer");
        if (!container) return;
        try {
            const tribes = await getTribes(currentGrade);
            if (!tribes.length) {
                container.innerHTML = '<div class="empty-chart"><i class="fas fa-mountain"></i><p style="color:#94A3B8;margin-top:8px;">Crea tribus para ver El Monte de las Virtudes</p></div>';
                return;
            }

            const sorted = [...tribes].sort((a,b) => (b.points||0)-(a.points||0));
            const maxPts = Math.max(...sorted.map(t => t.points||0), 1);
            const n = sorted.length;

            // Dynamic width: more tribes = wider canvas
            const W = Math.max(480, n * 110 + 80);
            // Generous top padding so labels never clip
            const H = 320;
            const groundY = H - 48;
            // Absolute scale: 500 pts = full height, so teams always feel near the bottom
            const SCALE_MAX = 500;
            const topReserve = 60;
            const maxH = groundY - topReserve;
            const minH = 18;

            const palettes = [
                { platform: '#C4B5FD', shadow: '#7C3AED', glow: 'rgba(167,139,250,0.55)', bar: '#8B5CF6', rank: '🏆' },
                { platform: '#93C5FD', shadow: '#1D4ED8', glow: 'rgba(147,197,253,0.45)', bar: '#3B82F6', rank: '🥈' },
                { platform: '#6EE7B7', shadow: '#047857', glow: 'rgba(110,231,183,0.45)', bar: '#10B981', rank: '🥉' },
                { platform: '#FCA5A5', shadow: '#B91C1C', glow: 'rgba(252,165,165,0.4)',  bar: '#EF4444', rank: '4'  },
                { platform: '#FDE68A', shadow: '#B45309', glow: 'rgba(253,230,138,0.4)',  bar: '#F59E0B', rank: '5'  },
                { platform: '#A5F3FC', shadow: '#0E7490', glow: 'rgba(165,243,252,0.4)',  bar: '#06B6D4', rank: '6'  },
            ];

            const positions = sorted.map((tribe, i) => {
                const pts = tribe.points || 0;
                // Height based on absolute scale (500 pts = top), not relative to current max
                const ratio = Math.min(pts / SCALE_MAX, 1);
                const platformH = pts === 0 ? minH : minH + ratio * (maxH - minH);
                const x = W * (i + 1) / (n + 1);
                const py = groundY - platformH;
                const pal = palettes[i % palettes.length];
                return { tribe, pts, x, py, platformH, pal, idx: i };
            });

            // ── DECORATIONS ────────────────────────────────────────────

            const clouds = [
                [W*0.12, groundY*0.22, 52, 18, 0.055],
                [W*0.35, groundY*0.13, 44, 14, 0.035],
                [W*0.72, groundY*0.28, 58, 19, 0.05 ],
                [W*0.88, groundY*0.18, 36, 12, 0.04 ],
            ].map(([cx,cy,rx,ry,op]) =>
                `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="rgba(255,255,255,${op})"/>`
            ).join('');

            // ── PLATFORMS ──────────────────────────────────────────────
            // Check if a custom background image exists (optional enhancement)
            // If ./img/chart-bg.jpg exists, it will be used; otherwise gradient fallback
            const bgImage = `<image href="./img/chart-bg.png" x="0" y="0" width="${W}" height="${H}"
                preserveAspectRatio="xMidYMid slice" opacity="0.6"
                onerror="this.style.display='none'"/>`;

            const platformsSVG = positions.map(p => {
                const cx = p.x, py = p.py;
                const pal = p.pal;

                // Emblem — smaller circles, glassmorphism style
                const emblemR  = p.idx === 0 ? 12 : 10;
                const emblemCY = py - emblemR - 6;
                const hasImage = !!p.tribe.imageData;

                // Soft glow under emblem (replaces platform glow)
                const glow = `<ellipse cx="${cx}" cy="${emblemCY+emblemR+8}" rx="${emblemR*1.4}" ry="6"
                    fill="${pal.glow}" filter="url(#blur5)" opacity="0.7"/>`;

                // Glassmorphism circle: frosted bg + colored border + inner sheen
                const platBody = `
                    <circle cx="${cx}" cy="${emblemCY}" r="${emblemR+6}"
                        fill="rgba(255,255,255,0.08)" stroke="${pal.platform}"
                        stroke-width="1.5" opacity="0.85"/>
                    <circle cx="${cx}" cy="${emblemCY}" r="${emblemR+6}"
                        fill="url(#glassGrad_${p.idx})" opacity="0.35"/>
                    <ellipse cx="${cx}" cy="${emblemCY - emblemR*0.3}" rx="${emblemR*0.7}" ry="${emblemR*0.25}"
                        fill="white" opacity="0.12"/>`;

                const emblemFill = hasImage
                    ? `<image href="${p.tribe.imageData}"
                           x="${cx-emblemR}" y="${emblemCY-emblemR}"
                           width="${emblemR*2}" height="${emblemR*2}"
                           clip-path="url(#clip_${p.idx})"
                           preserveAspectRatio="xMidYMid slice"/>`
                    : `<circle cx="${cx}" cy="${emblemCY}" r="${emblemR}"
                           fill="${pal.shadow}" opacity="0.8"/>
                       <text x="${cx}" y="${emblemCY+1}" text-anchor="middle"
                           dominant-baseline="middle" font-size="${emblemR}">🛡️</text>`;

                const emblemRing = `
                    <circle cx="${cx}" cy="${emblemCY}" r="${emblemR+1}"
                        fill="none" stroke="${pal.platform}" stroke-width="1.8" opacity="0.9"/>`;

                // Crown for leader
                const crown = p.idx === 0
                    ? `<text x="${cx}" y="${emblemCY - emblemR - 10}"
                           text-anchor="middle" font-size="13">✨</text>` : '';

                // Score — white, strong shadow
                const rawLabelY = emblemCY - emblemR - (p.idx === 0 ? 24 : 8);
                const labelY = Math.max(12, rawLabelY);
                const ptsLabel = `<text x="${cx}" y="${labelY}"
                    text-anchor="middle" font-size="13" font-weight="900"
                    fill="white" filter="url(#textShadow)">${p.pts}</text>`;

                // Name pill — dynamic width based on text length, never truncates unnecessarily
                const displayName = p.tribe.name.length > 16
                    ? p.tribe.name.slice(0, 15) + '…' : p.tribe.name;
                const pillW = Math.max(36, displayName.length * 4.5 + 10);
                const nameY = groundY + 20;
                const nameLabel = `
                    <rect x="${cx - pillW/2}" y="${nameY-11}" width="${pillW}" height="15"
                        rx="7" fill="rgba(0,0,0,0.5)"/>
                    <text x="${cx}" y="${nameY}"
                        text-anchor="middle" font-size="6.5" font-weight="600"
                        fill="rgba(255,255,255,0.92)">${escapeHtml(displayName)}</text>`;

                const clip = hasImage
                    ? `<clipPath id="clip_${p.idx}">
                           <circle cx="${cx}" cy="${emblemCY}" r="${emblemR}"/>
                       </clipPath>` : '';

                // Per-emblem glass gradient def
                const glassGradDef = `<radialGradient id="glassGrad_${p.idx}" cx="40%" cy="30%" r="70%">
                    <stop offset="0%" stop-color="white" stop-opacity="0.25"/>
                    <stop offset="100%" stop-color="${pal.shadow}" stop-opacity="0.1"/>
                </radialGradient>`;

                return { clip, glassDef: glassGradDef, svg: glow + platBody + emblemRing + emblemFill + crown + ptsLabel + nameLabel };
            });

            // ── DEFS ───────────────────────────────────────────────────
            const defs = `<defs>
                ${platformsSVG.map(p => p.clip).join('')}
                ${platformsSVG.map(p => p.glassDef).join('')}
                <filter id="blur5" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="5"/>
                </filter>
                <filter id="textShadow" x="-20%" y="-40%" width="140%" height="180%">
                    <feDropShadow dx="0" dy="1" stdDeviation="2.5"
                        flood-color="#0F172A" flood-opacity="0.9"/>
                </filter>
                <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stop-color="#0F172A"/>
                    <stop offset="60%"  stop-color="#1E1B4B"/>
                    <stop offset="100%" stop-color="#1E293B"/>
                </linearGradient>
                <linearGradient id="groundGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stop-color="rgba(99,102,241,0.18)"/>
                    <stop offset="100%" stop-color="rgba(15,23,42,0.5)"/>
                </linearGradient>
            </defs>`;

            // ── ASSEMBLE SVG ───────────────────────────────────────────
            const sceneSVG = `<svg class="rpg-scene"
                viewBox="0 0 ${W} ${H}"
                xmlns="http://www.w3.org/2000/svg"
                xmlns:xlink="http://www.w3.org/1999/xlink">
                ${defs}
                <!-- Background image (./img/chart-bg.png) with gradient fallback -->
                <rect x="0" y="0" width="${W}" height="${H}" fill="url(#skyGrad)"/>
                ${bgImage}
                ${platformsSVG.map(p => p.svg).join('')}
            </svg>`;

            // ── SIDEBAR ────────────────────────────────────────────────
            const sidebarCards = sorted.map((tribe, i) => {
                const pts = tribe.points || 0;
                const pct = Math.round((pts / maxPts) * 100);
                const pal = palettes[i % palettes.length];
                const emblem = tribe.imageData
                    ? `<img src="${tribe.imageData}" class="rpg-rank-emblem" alt="${escapeHtml(tribe.name)}">`
                    : `<div class="rpg-rank-emblem-placeholder" style="background:${pal.shadow}28;">🛡️</div>`;
                return `<div class="rpg-rank-card rank-${i < 3 ? i + 1 : 4}">
                    <div class="rpg-rank-num">${pal.rank}</div>
                    ${emblem}
                    <div class="rpg-rank-info">
                        <div class="rpg-rank-name" title="${escapeHtml(tribe.name)}">${escapeHtml(tribe.name)}</div>
                        <div class="rpg-rank-pts">${pts}</div>
                        <div class="rpg-rank-bar-wrap">
                            <div class="rpg-rank-bar-fill" style="width:${pct}%;background:${pal.bar}"></div>
                        </div>
                    </div>
                </div>`;
            }).join('');

            container.innerHTML = `<div class="rpg-chart-wrap">
                <div class="rpg-scene-wrap">${sceneSVG}</div>
                <div class="rpg-sidebar">${sidebarCards}</div>
            </div>`;

        } catch(e) { console.error(e); container.innerHTML = '<div class="empty-chart">Error al cargar</div>'; }
    }



    // ===== RENDER TRIBES =====
    async function renderTribes() {
        const container = document.getElementById("tribesContainer");
        container.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-pulse"></i> Cargando...</div>';
        try {
            const tribes = await getTribes(currentGrade);
            if (!tribes.length) { container.innerHTML = `<div class="empty-message"><i class="fas fa-users"></i><h3>Todavía no hay tribus</h3><p>Haz clic en "Crear Nueva Tribu"</p></div>`; return; }

            // Precargar TODOS los estudiantes para vincular miembros de tribu.
            // Si el caché está vacío, forzar recarga fresca desde Firestore.
            let allForLink = getCachedStudents();
            if (!allForLink.length) {
                await loadAllData(true);
                allForLink = getCachedStudents();
            }
            const studentsById = {};
            allForLink.forEach(s => { studentsById[s.id] = s; });

            // Fallback: si algún miembro tiene studentId pero no está en el caché,
            // buscarlo directamente en Firestore para no deshabilitar sus botones
            const missingIds = [];
            tribes.forEach(t => (t.members||[]).forEach(m => {
                if (m.studentId && !studentsById[m.studentId]) missingIds.push(m.studentId);
            }));
            if (missingIds.length) {
                await Promise.all([...new Set(missingIds)].map(async id => {
                    try {
                        const snap = await getDoc(doc(db, "students", id));
                        if (snap.exists()) {
                            const s = { id: snap.id, ...snap.data() };
                            studentsById[id] = s;
                            cacheUpdateStudent(id, s);
                        }
                    } catch(e) {}
                }));
            }
            window.__studentsByIdCache = studentsById;

            container.innerHTML = tribes.map(tribe => {
                const pts = tribe.points||0;
                const pct = Math.min(100,(pts/500)*100);
                const uid = tribe.id.replace(/[^a-zA-Z0-9]/g,'');
                return `<div class="tribe-card">
                    <div class="tribe-emblema">${tribe.imageData?`<img src="${tribe.imageData}">`:`<div class="tribe-emblema-placeholder">🛡️</div>`}</div>
                    <div class="tribe-header">
                        <div class="tribe-name">${escapeHtml(tribe.name)}</div>
                        ${tribe.warCry?`<div class="tribe-war-cry">⚡ "${escapeHtml(tribe.warCry)}"</div>`:''}
                    </div>
                    <div class="score-section">
                        <div class="score-label">🏆 PUNTUACIÓN 🏆</div>
                        <div class="score-value"><span>⭐</span><span id="points_${tribe.id}">${pts}</span><span>🏅</span></div>
                        <div class="progress-bar-container"><div class="progress-bar" style="width:${pct}%"></div></div>
                        <div class="score-buttons">
                            <button class="score-btn score-plus" onclick="window.addPoints('${tribe.id}',1)">+1</button>
                            <button class="score-btn score-plus" onclick="window.addPoints('${tribe.id}',3)">+3</button>
                            <button class="score-btn score-plus" onclick="window.addPoints('${tribe.id}',5)">+5</button>
                            <button class="score-btn score-minus" onclick="window.addPoints('${tribe.id}',-1)">-1</button>
                            <button class="score-btn score-minus" onclick="window.addPoints('${tribe.id}',-3)">-3</button>
                            <button class="score-btn score-minus" onclick="window.addPoints('${tribe.id}',-5)">-5</button>
                        </div>
                        <div class="score-custom">
                            <input type="number" id="customPoints_${uid}" placeholder="Cantidad" value="0" step="1">
                            <input type="text" id="customReason_${uid}" placeholder="Motivo (opcional)" style="width:140px;padding:5px 8px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:20px;color:#1E293B;font-size:12px;">
                            <button onclick="window.applyCustomPoints('${tribe.id}','${uid}')"><i class="fas fa-plus"></i> Aplicar</button>
                        </div>
                    </div>
                    <div class="members-section">
                        <h4>👥 INTEGRANTES (${(tribe.members||[]).length})</h4>
                        ${(tribe.members||[]).map((m,idx)=>{
                            const linkedStudent = m.studentId ? studentsById[m.studentId] : null;
                            const levelInfo = linkedStudent ? getLevelInfo(linkedStudent.individualPoints) : null;
                            const memberUid = `${tribe.id}_${idx}`.replace(/[^a-zA-Z0-9_]/g,'');
                            return `
                            <div class="member-item">
                                <div class="member-info">
                                    <span class="member-name">${escapeHtml(m.name)}</span>
                                    <span class="member-role">${escapeHtml(m.role)}</span>
                                    ${levelInfo ? `<span class="member-level" title="${levelInfo.points} pts · ${levelInfo.nextName?`Próximo: ${levelInfo.nextName} (${levelInfo.nextMin} pts)`:'Nivel máximo'}">${levelInfo.icon} ${levelInfo.name}</span>` : ''}
                                </div>
                                <div class="member-actions">
                                    ${linkedStudent ? `<button class="points-member" onclick="window.togglePointsForm('${memberUid}')" title="Puntos de nivel"><i class="fas fa-medal"></i></button><button class="reward-member" style="background:none;border:none;cursor:pointer;font-size:12px;transition:transform 0.2s;" onclick="window.toggleRewardForm('${memberUid}')" title="Puntos de recompensa 🪙"><i class="fas fa-coins"></i></button>` : `<button class="points-member points-member-disabled" onclick="window.showToast ? window.showToast('Este integrante no está vinculado a un estudiante registrado. Asígnalo desde el módulo de Estudiantes.','error') : null" title="No vinculado a un estudiante registrado"><i class="fas fa-medal"></i></button>`}
                                    <button class="edit-member" onclick="window.openEditMemberModal('${tribe.id}',${idx})"><i class="fas fa-edit"></i></button>
                                    <button class="delete-member" onclick="window.deleteMember('${tribe.id}',${idx})"><i class="fas fa-trash"></i></button>
                                </div>
                            </div>
                            ${linkedStudent ? `
                            <div class="reward-inline-form" id="rewardForm_${memberUid}" style="display:none;background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px;padding:10px 14px;margin:2px 0 4px;animation:fadeIn 0.2s ease;">
                                <div style="font-size:12px;color:#92400E;margin-bottom:8px;">🪙 Puntos de recompensa: <strong>${linkedStudent.rewardPoints||0}</strong></div>
                                <div style="display:flex;gap:8px;align-items:center;">
                                    <input type="number" id="rewardInput_${memberUid}" placeholder="Cantidad" value="10" step="1" style="width:90px;padding:6px 10px;border:1px solid #FDE68A;border-radius:8px;font-size:13px;text-align:center;">
                                    <button onclick="window.applyRewardPoints('${linkedStudent.id}','${memberUid}')" style="background:#F59E0B;color:white;border:none;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;"><i class="fas fa-check"></i> Asignar</button>
                                </div>
                            </div>
                            <div class="points-inline-form" id="pointsForm_${memberUid}" style="display:none;">
                                <div class="points-inline-level">
                                    ${levelInfo.icon} <strong>${levelInfo.name}</strong> · ${levelInfo.points} pts
                                    ${levelInfo.nextName ? `<div class="points-inline-bar"><div class="points-inline-bar-fill" style="width:${levelInfo.pctToNext}%"></div></div><span class="points-inline-next">Próximo: ${levelInfo.nextName} (${levelInfo.nextMin - levelInfo.points} pts restantes)</span>` : `<span class="points-inline-next">🌟 Nivel máximo alcanzado</span>`}
                                </div>
                                <div class="points-inline-controls">
                                    <input type="number" id="pointsInput_${memberUid}" placeholder="Cantidad" value="5" step="1">
                                    <input type="text" id="pointsReason_${memberUid}" placeholder="Motivo (opcional)" style="flex:1;padding:6px 10px;border:1px solid #E2E8F0;border-radius:8px;font-size:12px;">
                                    <button class="points-inline-apply" onclick="window.applyIndividualPoints('${linkedStudent.id}','${memberUid}','${tribe.id}')"><i class="fas fa-check"></i> Asignar</button>
                                </div>
                            </div>` : ''}`;
                        }).join('')}
                    </div>
                    <div class="add-member-form">
                        <select id="newMemberName_${tribe.id}" style="flex:1;min-width:120px;">
                            <option value="">— Seleccionar estudiante —</option>
                        </select>
                        <select id="newMemberRole_${tribe.id}">${rolesDisponibles.map(r=>`<option value="${r}">${r}</option>`).join('')}</select>
                        <button onclick="window.addMember('${tribe.id}')"><i class="fas fa-plus"></i></button>
                    </div>
                    <div class="tribe-actions">
                        <button class="edit-tribe" onclick="window.openEditTribeModal('${tribe.id}')">✏️ Editar Tribu</button>
                        <button class="delete-tribe" onclick="window.confirmDeleteTribe('${tribe.id}')">🗑️ Eliminar</button>
                    </div>
                </div>`;
            }).join('');

            // Populate student selects in each tribe's add-member form
            // Build set of studentIds already assigned to ANY tribe in this course
            const assignedAnywhere = new Set();
            tribes.forEach(t => (t.members || []).forEach(m => { if (m.studentId) assignedAnywhere.add(m.studentId); }));

            tribes.forEach(tribe => {
                const sel = document.getElementById(`newMemberName_${tribe.id}`);
                if (!sel) return;

                // Build options: disable if assigned to any tribe (including this one)
                const opts = allForLink.filter(s => {
                    // Solo mostrar estudiantes del curso actual en el dropdown de agregar miembro
                    return String(s.course) === String(currentGrade);
                }).map(s => {
                    const inThisTribe = (tribe.members || []).some(m => m.studentId === s.id);
                    const inOtherTribe = !inThisTribe && assignedAnywhere.has(s.id);
                    const otherTribeName = inOtherTribe
                        ? tribes.find(t => (t.members||[]).some(m => m.studentId === s.id))?.name || ''
                        : '';
                    const label = inThisTribe
                        ? `${s.name} ✓ (ya en esta tribu)`
                        : inOtherTribe
                            ? `${s.name} · En: ${otherTribeName}`
                            : s.name;
                    const disabled = inThisTribe || inOtherTribe ? 'disabled' : '';
                    return `<option value="${s.id}" ${disabled}>${escapeHtml(label)}</option>`;
                }).join('');

                sel.innerHTML = '<option value="">— Seleccionar estudiante —</option>' + opts;
            });

        } catch(e) { container.innerHTML = `<div class="empty-message"><p>❌ Error al cargar datos</p></div>`; }
    }

    // ===== WINDOW TRIBE ACTIONS =====
    let addPointsBusy = new Set(); // evita doble clic mientras se procesa el mismo tribeId
    window.addPoints = async (id, delta) => {
        if (addPointsBusy.has(id)) return; // ya hay una operación en curso para esta tribu
        addPointsBusy.add(id);
        try {
            await updatePoints(id, delta, 'manual');
            await renderTribes(); await renderChart();
        } finally {
            addPointsBusy.delete(id);
        }
    };
    window.togglePointsForm = (memberUid) => {
        const form = document.getElementById(`pointsForm_${memberUid}`);
        if (!form) return;
        const isOpen = form.style.display !== 'none';
        // Cerrar todos los demás formularios abiertos
        document.querySelectorAll('.points-inline-form').forEach(f => f.style.display = 'none');
        if (!isOpen) form.style.display = 'block';
    };
    window.toggleRewardForm = (memberUid) => {
        const form = document.getElementById(`rewardForm_${memberUid}`);
        if (!form) return;
        const isOpen = form.style.display !== 'none';
        document.querySelectorAll('.reward-inline-form,.points-inline-form').forEach(f => f.style.display = 'none');
        if (!isOpen) form.style.display = 'block';
    };
    window.applyRewardPoints = async (studentId, memberUid) => {
        const input = document.getElementById(`rewardInput_${memberUid}`);
        const delta = parseInt(input?.value);
        if (isNaN(delta) || delta === 0) { showToast('Ingresa una cantidad distinta de 0','error'); return; }
        try {
            const updated = await updateStudentRewardPoints(studentId, delta);
            showToast(`${delta>0?'+':''}${delta} 🪙 asignado`, 'success');
            input.value = 10;
            await renderTribes();
        } catch(e) { showToast('Error al asignar monedas','error'); }
    };

    window.applyIndividualPoints = async (studentId, memberUid, tribeId) => {
        const input = document.getElementById(`pointsInput_${memberUid}`);
        const reasonInput = document.getElementById(`pointsReason_${memberUid}`);
        const delta = parseInt(input?.value);
        const reason = reasonInput ? reasonInput.value.trim() : '';
        if (isNaN(delta) || delta === 0) { showToast('Ingresa una cantidad distinta de 0', 'error'); return; }
        const btn = document.querySelector(`#pointsForm_${memberUid} .points-inline-apply`);
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-pulse"></i>'; }
        try {
            const ar = await awardLevelPoints(studentId, delta, reason ? `manual: ${reason}` : 'manual');
            let msg = `${delta > 0 ? '+' : ''}${delta} pts · ${delta>0?'+':''}${delta}🪙 · ${ar.levelInfo.icon} ${ar.levelInfo.name}`;
            if (ar.leveledUp) msg += ` · ⬆️ +${ar.bonusCoins}🪙 bono`;
            showToast(msg, 'success');
            input.value = 5;
            if (reasonInput) reasonInput.value = '';
            await renderTribes();
        } catch(e) {
            showToast('Error al asignar puntos', 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Asignar'; }
        }
    };

    window.applyCustomPoints = async (id, uid) => {
        if (addPointsBusy.has(id)) return;
        const input = document.getElementById(`customPoints_${uid}`);
        const reasonInput = document.getElementById(`customReason_${uid}`);
        const v = parseInt(input.value);
        const reason = reasonInput ? reasonInput.value.trim() : '';
        if (isNaN(v)||v===0) { showToast("Ingresa un número válido", "error"); return; }
        addPointsBusy.add(id);
        try {
            const tribe = dataCache.tribes.find(t => t.id === id);
            if (tribe) {
                const newPts = Math.max(0, (tribe.points||0) + v);
                tribe.points = newPts;
                saveCacheToLocal();
                await updateDoc(doc(db,"tribes",id), { points: newPts });
                logPointsChange('tribe', id, tribe.name, v, newPts, reason ? `manual: ${reason}` : 'manual');
            }
            input.value = 0;
            if (reasonInput) reasonInput.value = '';
            await renderTribes(); await renderChart();
        } finally {
            addPointsBusy.delete(id);
        }
    };
    window.addMember = async (tribeId) => {
        const sel = document.getElementById(`newMemberName_${tribeId}`);
        const studentId = sel.value;
        const name = sel.options[sel.selectedIndex]?.text || '';
        const role = document.getElementById(`newMemberRole_${tribeId}`).value;
        if (!studentId) { showToast("Selecciona un estudiante","error"); return; }
        const tribes = await getTribes(currentGrade);
        const tribe = tribes.find(t=>t.id===tribeId);
        // Avoid duplicate
        if (tribe && (tribe.members||[]).find(m=>m.studentId===studentId)) {
            showToast("Este estudiante ya está en la tribu","error"); return;
        }
        if (tribe) {
            const newMembers = [...(tribe.members||[]), {name, role, studentId}];
            await updateMember(tribeId, newMembers);
            cacheUpdateTribe(tribeId, { members: newMembers });
            scheduleRepair(); // Reparar asistencia huérfana en segundo plano
            await renderTribes(); await renderChart();
        }
        sel.value = '';
        showToast("Integrante agregado ✅","success");
    };
    window.deleteMember = async (tribeId, idx) => {
        if (!confirm("¿Eliminar este integrante?")) return;
        const tribes = await getTribes(currentGrade);
        const tribe = tribes.find(t=>t.id===tribeId);
        if (tribe) {
            const newMembers = (tribe.members||[]).filter((_,i)=>i!==idx);
            await updateMember(tribeId, newMembers);
            cacheUpdateTribe(tribeId, { members: newMembers });
            scheduleRepair();
            await renderTribes(); await renderChart();
        }
    };
    window.openEditMemberModal = async (tribeId, idx) => {
        const tribes = await getTribes(currentGrade);
        const tribe = tribes.find(t=>t.id===tribeId);
        if (!tribe) return;
        const member = tribe.members[idx];
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:2000;display:flex;justify-content:center;align-items:center;';
        const mc = document.createElement('div');
        mc.style.cssText = 'background:#fff;padding:30px;border-radius:24px;width:90%;max-width:400px;border:2px solid #3B82F6;box-shadow:0 20px 60px rgba(0,0,0,0.3);';
        mc.innerHTML = `<h3 style="margin-bottom:20px;color:#1E293B;">✏️ Editar Integrante</h3>
            <label style="display:block;margin-bottom:5px;color:#64748B;font-size:14px;">👤 Nombre</label>
            <input type="text" id="editMemberName" value="${escapeHtml(member.name)}" style="width:100%;padding:10px 12px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;color:#1E293B;font-size:14px;margin-bottom:12px;">
            <label style="display:block;margin-bottom:5px;color:#64748B;font-size:14px;">🎯 Rol</label>
            <select id="editMemberRole" style="width:100%;padding:10px 12px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;color:#1E293B;font-size:14px;margin-bottom:20px;">
                ${rolesDisponibles.map(r=>`<option value="${r}" ${member.role===r?'selected':''}>${r}</option>`).join('')}
            </select>
            <div style="display:flex;gap:10px;">
                <button id="saveEditMember" style="flex:1;padding:10px;background:#3B82F6;border:none;border-radius:30px;color:white;font-weight:bold;cursor:pointer;">💾 Guardar</button>
                <button id="cancelEditMember" style="flex:1;padding:10px;background:#E2E8F0;border:none;border-radius:30px;color:#475569;font-weight:bold;cursor:pointer;">Cancelar</button>
            </div>`;
        overlay.appendChild(mc); document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target===overlay) overlay.remove(); });
        mc.querySelector('#saveEditMember').addEventListener('click', async () => {
            const newName = document.getElementById('editMemberName').value.trim();
            const newRole = document.getElementById('editMemberRole').value;
            if (!newName) { showToast("El nombre no puede estar vacío","error"); return; }
            const newMembers = [...tribe.members];
            newMembers[idx] = {...member, name:newName, role:newRole};
            await updateMember(tribeId, newMembers);
            cacheUpdateTribe(tribeId, { members: newMembers });
            await renderTribes(); await renderChart();
            overlay.remove(); showToast("Integrante actualizado ✅","success");
        });
        mc.querySelector('#cancelEditMember').addEventListener('click', () => overlay.remove());
    };
    window.openEditTribeModal = async (tribeId) => {
        const tribes = await getTribes(currentGrade);
        const tribe = tribes.find(t=>t.id===tribeId);
        if (!tribe) return;
        editingTribeId = tribeId; tempImageData = tribe.imageData||null;
        document.getElementById("tribeName").value = tribe.name;
        document.getElementById("tribeWarCry").value = tribe.warCry||"";
        document.getElementById("imagePreview").innerHTML = tribe.imageData?`<img src="${tribe.imageData}">`:`<div class="tribe-emblema-placeholder">🏹</div>`;
        document.getElementById("modalTitle").innerHTML = "✏️ Editar Tribu ✏️";
        openModal("tribeModal");
    };
    window.confirmDeleteTribe = async (tribeId) => {
        const tribe = getCachedTribes(currentGrade).find(t=>t.id===tribeId);
        if (!tribe) return;
        const memberCount = (tribe.members||[]).length;
        if (!confirm(`¿Eliminar la tribu "${tribe.name}"?${memberCount ? ` Tiene ${memberCount} integrante(s) asignado(s).` : ''}`)) return;
        if (!confirm(`Confirma una vez más: se eliminará "${tribe.name}" de forma permanente, junto con sus puntos e integrantes asignados. Esta acción no se puede deshacer. ¿Continuar?`)) return;
        await deleteTribe(tribeId);
        cacheDeleteTribe(tribeId);
        await renderTribes(); await renderChart();
        showToast(`Tribu "${tribe.name}" eliminada`, '');
    };

    // ===== COURSES NAV =====
    function renderCoursesNav() {
        const c = document.getElementById("coursesNav");
        c.innerHTML = Object.keys(courseNames).map(g=>`<button class="course-btn ${parseInt(g)===currentGrade?'active':''}" data-grade="${g}">${courseNames[g]}</button>`).join('');
        document.querySelectorAll(".course-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                currentGrade = parseInt(btn.dataset.grade);
                renderCoursesNav();
                document.getElementById("selectedGrade").textContent = courseNames[currentGrade];
                renderTribes(); renderChart();
            });
        });
    }

    // ===== TRIBE MODAL =====
    function openAddTribeModal() {
        editingTribeId = null; tempImageData = null;
        document.getElementById("tribeName").value="";
        document.getElementById("tribeWarCry").value="";
        document.getElementById("tribeImage").value="";
        document.getElementById("imagePreview").innerHTML=`<div class="tribe-emblema-placeholder">🏹</div>`;
        document.getElementById("modalTitle").innerHTML="✨ Crear Nueva Tribu ✨";
        openModal("tribeModal");
    }
    async function saveTribeFromModal() {
        const name = document.getElementById("tribeName").value.trim();
        if (!name) { showToast("Ingresa el nombre de la tribu","error"); return; }
        const tribeData = { grade:currentGrade, name, imageData:tempImageData, warCry:document.getElementById("tribeWarCry").value.trim(), members:[], points:0, createdAt:new Date().toISOString() };
        let savedId;
        if (editingTribeId) {
            const existing = getCachedTribes(currentGrade).find(t=>t.id===editingTribeId);
            if (existing) { tribeData.members=existing.members||[]; tribeData.points=existing.points||0; }
            delete tribeData.createdAt;
            savedId = await saveTribe(tribeData, editingTribeId);
            cacheUpdateTribe(editingTribeId, tribeData);
        } else {
            savedId = await saveTribe(tribeData, null);
            cacheAddTribe({ id: savedId, ...tribeData });
        }
        closeModal("tribeModal"); editingTribeId=null;
        await renderTribes(); await renderChart();
        showToast("Tribu guardada ✅","success");
    }
    document.getElementById("tribeImage").addEventListener("change", function(e) {
        const file = e.target.files[0];
        if (file) { const r=new FileReader(); r.onload=ev=>{tempImageData=ev.target.result;document.getElementById("imagePreview").innerHTML=`<img src="${tempImageData}">`;}; r.readAsDataURL(file); }
    });
    document.getElementById("logoutBtn").onclick = async () => {
        await signOut(auth);
        window.location.href="index.html";
    };

    // ===== RESPALDO COMPLETO (JSON) =====
    document.getElementById("backupBtn").onclick = async () => {
        const btn = document.getElementById('backupBtn');
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> <span>Generando...</span>';
        try {
            const collectionsToBackup = ['tribes', 'students', 'attendance', 'redemptions', 'rewards', 'quizResults', 'pointsLog'];
            const backup = { generatedAt: new Date().toISOString(), project: 'ethicos-a9a66', data: {} };

            for (const colName of collectionsToBackup) {
                const snap = await getDocs(collection(db, colName));
                backup.data[colName] = snap.docs.map(d => {
                    const raw = d.data();
                    // Convertir Timestamps de Firestore a texto legible para que el JSON sea portable
                    const clean = {};
                    Object.keys(raw).forEach(k => {
                        const v = raw[k];
                        clean[k] = (v && typeof v === 'object' && typeof v.toDate === 'function') ? v.toDate().toISOString() : v;
                    });
                    return { id: d.id, ...clean };
                });
            }

            const json = JSON.stringify(backup, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
            a.href = url;
            a.download = `ethykos_respaldo_${stamp}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            const totalDocs = Object.values(backup.data).reduce((sum, arr) => sum + arr.length, 0);
            showToast(`✅ Respaldo descargado (${totalDocs} registros en total)`, 'success');
        } catch(e) {
            console.error(e);
            showToast('Error al generar el respaldo', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    };

    // ===== LOG DE CAMBIOS DE PUNTOS =====
    let plogCache = [];
    const plogSourceLabels = {
        attendance: '📷 Asistencia', manual: '✋ Manual', syllabus: '📄 Syllabus',
        backfill: '🔧 Backfill', repair: '🔧 Auto-reparación', shop_redeem: '🛒 Canje tienda'
    };
    const plogTypeLabels = { tribe: '🛡️ Tribu', individual: '⭐ Nivel', coins: '🪙 Moneda' };

    async function loadPointsLog() {
        const tbody = document.getElementById('plogTableBody');
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94A3B8;">Cargando...</td></tr>';
        try {
            const snap = await getDocs(collection(db, "pointsLog"));
            plogCache = snap.docs.map(d => ({ id: d.id, ...d.data() }))
                .sort((a,b) => (b.timestamp?.seconds||0) - (a.timestamp?.seconds||0));
            renderPointsLog();
        } catch(e) {
            console.error(e);
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#DC2626;">Error al cargar el log</td></tr>';
        }
    }

    function renderPointsLog() {
        const typeFilter = document.getElementById('plog-type').value;
        const sourceFilter = document.getElementById('plog-source').value;
        const search = document.getElementById('plog-search').value.toLowerCase().trim();
        const dateFrom = document.getElementById('plog-date-from').value; // 'YYYY-MM-DD'
        const dateTo = document.getElementById('plog-date-to').value;

        let filtered = plogCache;
        if (typeFilter) filtered = filtered.filter(l => l.type === typeFilter);
        if (sourceFilter) filtered = filtered.filter(l => (l.source || '').startsWith(sourceFilter));
        if (search) filtered = filtered.filter(l => (l.targetName||'').toLowerCase().includes(search));
        if (dateFrom) filtered = filtered.filter(l => {
            try { return new Date(l.timestamp.seconds*1000) >= new Date(dateFrom); } catch(e) { return true; }
        });
        if (dateTo) filtered = filtered.filter(l => {
            try { return new Date(l.timestamp.seconds*1000) <= new Date(dateTo + 'T23:59:59'); } catch(e) { return true; }
        });

        document.getElementById('plogResultsCount').textContent = `${filtered.length} registro(s) encontrado(s)`;
        const tbody = document.getElementById('plogTableBody');
        if (!filtered.length) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94A3B8;">Sin registros para este filtro. Los cambios se registran desde que se activó la colección en Firestore.</td></tr>';
            return;
        }
        tbody.innerHTML = filtered.slice(0, 300).map(l => {
            let dateStr = 'N/A';
            try { dateStr = new Date(l.timestamp.seconds*1000).toLocaleString('es-CO',{dateStyle:'short',timeStyle:'short'}); } catch(e) {}
            const deltaStr = (l.delta > 0 ? '+' : '') + l.delta;
            const deltaColor = l.delta > 0 ? '#059669' : '#DC2626';
            const sourceRaw = l.source || 'manual';
            const sourceKey = Object.keys(plogSourceLabels).find(k => sourceRaw.startsWith(k)) || '';
            const sourceLabel = sourceKey ? plogSourceLabels[sourceKey] : '✋ Manual';
            const motivo = sourceRaw.includes(':') ? sourceRaw.split(':').slice(1).join(':').trim() : '';
            const origenCell = motivo ? `${sourceLabel}<br><span style="font-size:10px;color:#64748B;">${escapeHtml(motivo)}</span>` : sourceLabel;
            return `<tr>
                <td style="white-space:nowrap;">${escapeHtml(dateStr)}</td>
                <td>${plogTypeLabels[l.type] || escapeHtml(l.type)}</td>
                <td style="font-weight:600;">${escapeHtml(l.targetName || '—')}</td>
                <td style="font-weight:700;color:${deltaColor};">${escapeHtml(String(deltaStr))}</td>
                <td>${escapeHtml(String(l.resultingValue ?? '—'))}</td>
                <td>${origenCell}</td>
                <td style="font-size:11px;color:#64748B;">${escapeHtml(l.actorEmail || '—')}</td>
            </tr>`;
        }).join('') + (filtered.length > 300 ? `<tr><td colspan="7" style="text-align:center;color:#94A3B8;font-size:11px;">Mostrando los 300 más recientes. Usa los filtros para acotar.</td></tr>` : '');
    }

    document.getElementById('pointsLogBtn').onclick = async () => { openModal('pointsLogModal'); await loadPointsLog(); };
    document.getElementById('closePointsLogBtn').onclick = () => closeModal('pointsLogModal');
    document.getElementById('plog-refreshBtn').onclick = loadPointsLog;
    document.getElementById('plog-clearBtn').onclick = () => {
        document.getElementById('plog-type').value = '';
        document.getElementById('plog-source').value = '';
        document.getElementById('plog-search').value = '';
        document.getElementById('plog-date-from').value = '';
        document.getElementById('plog-date-to').value = '';
        renderPointsLog();
    };
    ['plog-type','plog-source','plog-date-from','plog-date-to'].forEach(id =>
        document.getElementById(id).addEventListener('change', renderPointsLog)
    );
    document.getElementById('plog-search').addEventListener('input', renderPointsLog);

    document.getElementById("addTribeBtn").onclick = openAddTribeModal;
    document.getElementById("saveTribeBtn").onclick = saveTribeFromModal;
    document.getElementById("cancelModalBtn").onclick = () => closeModal("tribeModal");
    window.onclick = (e) => { if (e.target===document.getElementById("tribeModal")) closeModal("tribeModal"); };

    // ===== STUDENTS MODAL =====
    document.getElementById("studentsBtn").onclick = () => { openModal("studentsModal"); loadStudentList(); };
    document.getElementById("closeStudentsBtn").onclick = () => closeModal("studentsModal");

    // Tabs
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
            document.querySelectorAll(".tab-panel").forEach(p=>p.classList.remove("active"));
            btn.classList.add("active");
            document.getElementById(btn.dataset.tab).classList.add("active");
        });
    });

    // Búsqueda estudiantes
    let allStudents = [];
    async function loadStudentList() {
        const list = document.getElementById("studentList");
        list.innerHTML='<div class="loading"><i class="fas fa-spinner fa-pulse"></i> Cargando...</div>';
        allStudents = await getStudents(null);
        applyStudentFilter();
    }
    function applyStudentFilter() {
        const q = document.getElementById('studentSearch').value.toLowerCase();
        const filtered = q
            ? allStudents.filter(s => s.name.toLowerCase().includes(q) || (s.document||'').includes(q) || String(s.course).includes(q))
            : allStudents;
        renderStudentList(filtered);
    }
    function renderStudentList(students) {
        const list = document.getElementById("studentList");
        if (!students.length) { list.innerHTML='<div style="text-align:center;color:#94A3B8;padding:20px;">No hay estudiantes registrados</div>'; return; }
        list.innerHTML = students.map(s => {
            const lvl = getLevelInfo(s.individualPoints);
            const rp = s.rewardPoints || 0;
            return `<div class="student-row">
                <div class="student-row-top">
                    <div>
                        <span class="sname">${escapeHtml(s.name)}</span>
                        <span class="sdoc" style="margin-left:6px;">${escapeHtml(s.document||'')}</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                        <span class="scourse">${courseNames[s.course]||s.course}</span>
                        <div class="sactions">
                            <button class="assign-btn" onclick="window.openAssignTribe('${s.id}','${escapeHtml(s.name)}',${s.course})">🏹 Asignar</button>
                            <button class="del-student-btn" onclick="window.removeStudent('${s.id}')"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>
                </div>
                <div class="student-row-pts">
                    <span class="pts-badge level">${lvl.icon} ${lvl.name} · ${lvl.points} pts</span>
                    <button class="pts-badge-btn plus" onclick="window.quickStudentPts('${s.id}','level',1)">+1</button>
                    <button class="pts-badge-btn plus" onclick="window.quickStudentPts('${s.id}','level',5)">+5</button>
                    <button class="pts-badge-btn minus" onclick="window.quickStudentPts('${s.id}','level',-1)">-1</button>
                    <span style="width:1px;height:14px;background:#E2E8F0;margin:0 2px;"></span>
                    <span class="pts-badge reward">🪙 ${rp} pts</span>
                    <button class="pts-badge-btn plus" onclick="window.quickStudentPts('${s.id}','reward',5)">+5</button>
                    <button class="pts-badge-btn plus" onclick="window.quickStudentPts('${s.id}','reward',10)">+10</button>
                    <button class="pts-badge-btn minus" onclick="window.quickStudentPts('${s.id}','reward',-5)">-5</button>
                    <span style="width:1px;height:14px;background:#E2E8F0;margin:0 2px;"></span>
                    ${s.syllabusDelivered
                        ? `<span class="syllabus-badge done"><i class="fas fa-check-circle"></i> Syllabus entregado</span>`
                        : `<button class="syllabus-badge pending" onclick="window.markSyllabusDelivered('${s.id}')"><i class="fas fa-file-arrow-up"></i> Marcar entrega Syllabus (+10 pts)</button>`
                    }
                </div>
            </div>`;
        }).join('');
    }
    window.quickStudentPts = async (studentId, type, delta) => {
        try {
            if (type === 'level') {
                const ar = await awardLevelPoints(studentId, delta, 'manual');
                if (ar?.leveledUp) {
                    showToast(`⬆️ ¡Subió a ${ar.levelInfo.icon} ${ar.levelInfo.name}! +${delta}🪙 · +${ar.bonusCoins}🪙 bono`, 'success');
                }
            } else {
                await updateStudentRewardPoints(studentId, delta);
            }
            // Refresh list from cache
            const idx = allStudents.findIndex(s=>s.id===studentId);
            if (idx>=0) {
                allStudents[idx] = dataCache.students.find(s => s.id === studentId) || allStudents[idx];
            }
            applyStudentFilter();
        } catch(e) { showToast('Error al actualizar puntos','error'); }
    };

    window.markSyllabusDelivered = async (studentId) => {
        try {
            const student = dataCache.students.find(s => s.id === studentId);
            if (!student) return;
            if (student.syllabusDelivered) {
                showToast('Ya se había registrado la entrega de este estudiante', '');
                return;
            }
            await updateDoc(doc(db, "students", studentId), { syllabusDelivered: true });
            student.syllabusDelivered = true;
            saveCacheToLocal();

            const ar = await awardLevelPoints(studentId, 10, 'syllabus');
            let msg = `📄 Entrega de Syllabus registrada (+10pts · +10🪙)`;
            if (ar?.leveledUp) msg += ` · ⬆️ ¡Subió a ${ar.levelInfo.icon} ${ar.levelInfo.name}! (+${ar.bonusCoins}🪙 bono)`;
            showToast(msg, 'success');

            const idx = allStudents.findIndex(s => s.id === studentId);
            if (idx >= 0) allStudents[idx] = student;
            applyStudentFilter();
        } catch(e) { showToast('Error al registrar la entrega','error'); }
    };
    document.getElementById("studentSearch").addEventListener("input", applyStudentFilter);

    // Agregar uno
    document.getElementById("saveOneStudentBtn").onclick = async () => {
        const name = document.getElementById("newStudentName").value.trim();
        const course = document.getElementById("newStudentCourse").value;
        const document_ = document.getElementById("newStudentDoc").value.trim();
        if (!name) { showToast("Ingresa el nombre","error"); return; }
        await saveStudent({ name, course, document: document_, createdAt: new Date().toISOString() });
        document.getElementById("newStudentName").value="";
        document.getElementById("newStudentDoc").value="";
        showToast("Estudiante guardado ✅","success");
        loadStudentList();
    };

    // CSV
    const csvArea = document.getElementById("csvDropArea");
    csvArea.addEventListener("click", () => document.getElementById("csvFileInput").click());
    csvArea.addEventListener("dragover", e=>{ e.preventDefault(); csvArea.style.borderColor="#3B82F6"; csvArea.style.background="#EFF6FF"; });
    csvArea.addEventListener("dragleave", ()=>{ csvArea.style.borderColor=""; csvArea.style.background=""; });
    csvArea.addEventListener("drop", e=>{ e.preventDefault(); csvArea.style.borderColor=""; csvArea.style.background=""; if(e.dataTransfer.files[0]) processCSV(e.dataTransfer.files[0]); });
    document.getElementById("csvFileInput").addEventListener("change", e=>{ if(e.target.files[0]) processCSV(e.target.files[0]); });

    function processCSV(file) {
        const reader = new FileReader();
        reader.onload = e => {
            const text = e.target.result;
            const lines = text.split('\n').filter(l=>l.trim());
            if (!lines.length) return;
            // Detectar encabezado
            const firstLine = lines[0].toLowerCase();
            const startIdx = (firstLine.includes('nombre')||firstLine.includes('name')) ? 1 : 0;
            csvParsedData = [];
            for (let i=startIdx; i<lines.length; i++) {
                const cols = lines[i].split(',').map(c=>c.trim().replace(/^"|"$/g,''));
                if (cols.length>=1 && cols[0]) {
                    csvParsedData.push({ name: cols[0], course: cols[1]||'', document: cols[2]||'' });
                }
            }
            document.getElementById("csvPreviewMsg").textContent = `${csvParsedData.length} estudiantes encontrados:`;
            document.getElementById("csvPreview").innerHTML = csvParsedData.slice(0,10).map(s=>`
                <div class="csv-row"><span style="flex:2;font-weight:500;">${escapeHtml(s.name)}</span><span style="flex:1;">${escapeHtml(s.course)}</span><span style="flex:1;color:#94A3B8;">${escapeHtml(s.document)}</span></div>`).join('') + (csvParsedData.length>10?`<div style="text-align:center;color:#94A3B8;font-size:12px;padding:8px;">...y ${csvParsedData.length-10} más</div>`:'');
            document.getElementById("csvPreviewContainer").style.display="block";
        };
        reader.readAsText(file);
    }
    document.getElementById("importCsvBtn").onclick = async () => {
        if (!csvParsedData.length) return;
        let count=0;
        for (const s of csvParsedData) {
            await saveStudent({ name:s.name, course:s.course, document:s.document, createdAt:new Date().toISOString() });
            count++;
        }
        showToast(`${count} estudiantes importados ✅`,"success");
        csvParsedData=[];
        document.getElementById("csvPreviewContainer").style.display="none";
        document.getElementById("csvFileInput").value="";
        loadStudentList();
        // Cambiar a tab lista
        document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach(p=>p.classList.remove("active"));
        document.querySelector('[data-tab="listTab"]').classList.add("active");
        document.getElementById("listTab").classList.add("active");
    };

    // ===== ASSIGN TRIBE =====
    window.openAssignTribe = async (studentId, studentName, studentCourse) => {
        assigningStudent = { id: studentId, name: studentName, course: studentCourse };
        document.getElementById("assignStudentName").textContent = `Asignar a: ${studentName}`;
        const tribes = await getTribes(parseInt(studentCourse));
        const list = document.getElementById("tribeOptionsList");
        if (!tribes.length) { list.innerHTML='<div style="color:#94A3B8;text-align:center;padding:20px;">No hay tribus en este curso</div>'; }
        else {
            list.innerHTML = tribes.map(t=>`
                <div class="tribe-option" onclick="window.assignToTribe('${t.id}','${escapeHtml(t.name)}')">
                    ${t.imageData?`<img src="${t.imageData}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:2px solid #3B82F6;">`:`<div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#3B82F6,#2563EB);display:flex;align-items:center;justify-content:center;font-size:18px;">🛡️</div>`}
                    <div>
                        <div class="to-name">${escapeHtml(t.name)}</div>
                        <div class="to-count">${(t.members||[]).length} integrantes</div>
                    </div>
                </div>`).join('');
        }
        openModal("assignTribeModal");
    };
    window.assignToTribe = async (tribeId, tribeName) => {
        if (!assigningStudent) return;
        const tribe = getCachedTribes(parseInt(assigningStudent.course)).find(t=>t.id===tribeId);
        if (!tribe) return;
        const existingMembers = tribe.members||[];
        if (!existingMembers.find(m=>m.name===assigningStudent.name)) {
            const newMembers = [...existingMembers, { name: assigningStudent.name, role: "Explorador", studentId: assigningStudent.id }];
            await updateMember(tribeId, newMembers);
            cacheUpdateTribe(tribeId, { members: newMembers });
            scheduleRepair(); // Reparar asistencia huérfana en segundo plano
        }
        closeModal("assignTribeModal");
        showToast(`${assigningStudent.name} asignado/a a ${tribeName} ✅`,"success");
        if (parseInt(assigningStudent.course)===currentGrade) {
            await renderTribes(); await renderChart();
        }
        assigningStudent = null;
    };
    document.getElementById("closeAssignBtn").onclick = () => closeModal("assignTribeModal");
    window.removeStudent = async (id) => {
        const student = dataCache.students.find(s => s.id === id) || allStudents.find(s => s.id === id);
        const name = student?.name || 'este estudiante';
        if (!confirm(`¿Eliminar a "${name}"?`)) return;
        if (!confirm(`Confirma una vez más: se eliminará a "${name}" de forma permanente (perfil, puntos, historial no se ven afectados, pero ya no podrá registrar asistencia ni aparecer en listados). Esta acción no se puede deshacer. ¿Continuar?`)) return;
        await deleteStudent(id);
        showToast(`"${name}" eliminado`,"");
        loadStudentList();
    };

    // ===== ATTENDANCE QR =====
    document.getElementById("attendanceBtn").onclick = () => {
        try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch(e) {}
        const savedCameraId = localStorage.getItem('ethykos_preferredCameraId') || undefined;
        openModal("attendanceModal"); startQRScanner(savedCameraId); loadAttendanceLog(); loadQRGeneratorGrid(); initManualAttendance();
    };
    document.getElementById("closeAttendanceBtn").onclick = () => { stopQRScanner(); closeModal("attendanceModal"); };

    // ===== REGISTRO MANUAL (código dañado o extraviado) =====
    let manualAttSearchable = null;
    async function initManualAttendance() {
        const students = getCachedStudents().length ? getCachedStudents() : await getStudents(null);
        if (!manualAttSearchable) {
            manualAttSearchable = createSearchableSelect({
                inputId: 'manualAttInput', hiddenId: 'manualAttStudentDoc', listId: 'manualAttList',
                items: students,
                getLabel: s => `${s.name} (${courseNames[s.course]||s.course}°)`,
                getValue: s => s.document || '',
                onSelect: () => {}
            });
        } else {
            manualAttSearchable.setItems(students);
        }
    }
    document.getElementById('manualAttBtn').onclick = async () => {
        const docNum = document.getElementById('manualAttStudentDoc').value;
        if (!docNum) { showToast('Busca y selecciona un estudiante de la lista primero', 'error'); return; }
        await registerAttendanceByDocument(docNum);
        document.getElementById('manualAttInput').value = '';
        document.getElementById('manualAttStudentDoc').value = '';
    };

    async function loadAttendanceLog() {
        const records = await getTodayAttendance();
        scannedToday = new Set(records.map(r=>`${r.studentDoc}_${r.date}`));
        renderAttendanceLog(records);
    }
    function renderAttendanceLog(records) {
        document.getElementById("attCount").textContent = records.length;
        const log = document.getElementById("attendanceLog");
        if (!records.length) { log.innerHTML='<div style="color:#94A3B8;text-align:center;padding:15px;font-size:13px;">Nadie registrado aún hoy</div>'; return; }
        log.innerHTML = records.sort((a,b)=>b.timestamp?.seconds-a.timestamp?.seconds||0).map(r=>`
            <div class="att-entry">
                <div><div class="att-name">${escapeHtml(r.studentName)}</div><div class="att-tribe">🏹 ${escapeHtml(r.tribeName||'Sin tribu')}</div></div>
                <div class="att-time">${r.date}</div>
            </div>`).join('');
    }

    // QR Scanner
    let qrCanvas = document.createElement('canvas');
    let qrCtx = qrCanvas.getContext('2d');
    async function startQRScanner(preferredDeviceId) {
        const statusEl = document.getElementById('qr-status-msg');
        const video = document.getElementById('qr-video');
        statusEl.textContent = '📷 Activando cámara...';
        statusEl.className = 'status-msg status-waiting';
        try {
            if (preferredDeviceId) {
                // El profe eligió una cámara específica (ej. webcam USB apuntando a los estudiantes)
                qrStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: preferredDeviceId } } });
            } else {
                // Intentar cámara trasera primero, con fallback a cualquier cámara disponible
                try {
                    qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
                } catch (e1) {
                    qrStream = await navigator.mediaDevices.getUserMedia({ video: true });
                }
            }
            video.srcObject = qrStream;
            await video.play();

            // Esperar a que el video tenga dimensiones reales antes de escanear
            await new Promise(resolve => {
                if (video.videoWidth > 0) return resolve();
                video.addEventListener('loadedmetadata', resolve, { once: true });
            });

            qrCanvas.width = video.videoWidth;
            qrCanvas.height = video.videoHeight;

            if (!getJsQR()) {
                statusEl.textContent = '⚠️ Error: la librería de escaneo (jsQR) no cargó. Revisa tu conexión a internet y recarga la página.';
                statusEl.className = 'status-msg status-error';
                return;
            }

            statusEl.textContent = '📷 Esperando código QR...';
            statusEl.className = 'status-msg status-waiting';

            if (qrScanInterval) clearInterval(qrScanInterval);
            qrScanInterval = setInterval(() => scanFrame(video), 250);

            // Con la cámara ya autorizada, los nombres de los dispositivos quedan visibles
            await populateCameraList();
        } catch(e) {
            console.error('Error de cámara:', e);
            statusEl.textContent = '⚠️ No se pudo acceder a la cámara: ' + (e.message||e.name||'desconocido');
            statusEl.className = 'status-msg status-error';
        }
    }
    async function populateCameraList() {
        const sel = document.getElementById('qr-camera-select');
        if (!sel) return;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const cams = devices.filter(d => d.kind === 'videoinput');
            if (!cams.length) return;
            const activeTrack = qrStream?.getVideoTracks?.()[0];
            const activeId = activeTrack?.getSettings?.().deviceId || '';
            sel.innerHTML = cams.map((c,i) =>
                `<option value="${c.deviceId}">${escapeHtml(c.label || ('Cámara ' + (i+1)))}</option>`
            ).join('');
            if (activeId) sel.value = activeId;
        } catch(e) { console.error('No se pudo listar las cámaras disponibles', e); }
    }
    document.getElementById('qr-camera-select').addEventListener('change', async function() {
        const deviceId = this.value;
        if (!deviceId) return;
        localStorage.setItem('ethykos_preferredCameraId', deviceId);
        stopQRScanner();
        await startQRScanner(deviceId);
    });
    function stopQRScanner() {
        if (qrScanInterval) { clearInterval(qrScanInterval); qrScanInterval=null; }
        if (qrStream) { qrStream.getTracks().forEach(t=>t.stop()); qrStream=null; }
    }
    function getJsQR() {
        if (typeof window.jsQR === 'function') return window.jsQR;
        if (typeof jsQR === 'function') return jsQR;
        return null;
    }
    let lastScanTime = 0;
    function scanFrame(video) {
        if (video.readyState !== video.HAVE_ENOUGH_DATA || !video.videoWidth) return;
        const decode = getJsQR();
        if (!decode) {
            console.error('jsQR no está disponible. Verifica que la librería se haya cargado correctamente.');
            return;
        }
        if (qrCanvas.width !== video.videoWidth) qrCanvas.width = video.videoWidth;
        if (qrCanvas.height !== video.videoHeight) qrCanvas.height = video.videoHeight;
        qrCtx.drawImage(video, 0, 0, qrCanvas.width, qrCanvas.height);
        const imageData = qrCtx.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
        const code = decode(imageData.data, imageData.width, imageData.height, { inversionAttempts: "attemptBoth" });
        if (code && code.data && Date.now() - lastScanTime > 2000) {
            lastScanTime = Date.now();
            processQRCode(code.data);
        }
    }
    // ===== FEEDBACK SONORO Y VISUAL =====
    let audioCtx = null;
    function playBeep(type) {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            const now = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain); gain.connect(audioCtx.destination);

            if (type === 'success') {
                // Doble beep ascendente, alegre
                osc.type = 'sine';
                osc.frequency.setValueAtTime(880, now);
                osc.frequency.setValueAtTime(1175, now + 0.1);
                gain.gain.setValueAtTime(0.0001, now);
                gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
                osc.start(now); osc.stop(now + 0.24);
            } else if (type === 'duplicate') {
                // Tono medio, de advertencia
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(520, now);
                gain.gain.setValueAtTime(0.0001, now);
                gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
                osc.start(now); osc.stop(now + 0.32);
            } else {
                // Tono grave doble, de error
                osc.type = 'square';
                osc.frequency.setValueAtTime(220, now);
                gain.gain.setValueAtTime(0.0001, now);
                gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
                osc.start(now); osc.stop(now + 0.17);
                setTimeout(() => {
                    const osc2 = audioCtx.createOscillator();
                    const gain2 = audioCtx.createGain();
                    osc2.connect(gain2); gain2.connect(audioCtx.destination);
                    osc2.type = 'square';
                    osc2.frequency.setValueAtTime(220, audioCtx.currentTime);
                    gain2.gain.setValueAtTime(0.0001, audioCtx.currentTime);
                    gain2.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.02);
                    gain2.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.15);
                    osc2.start(); osc2.stop(audioCtx.currentTime + 0.17);
                }, 180);
            }
        } catch(e) { /* audio no disponible, se ignora silenciosamente */ }
    }
    function vibrateDevice(pattern) {
        if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch(e) {} }
    }
    function flashFrame(type) {
        const frame = document.querySelector('.qr-frame');
        if (!frame) return;
        const color = type === 'success' ? '#10B981' : type === 'duplicate' ? '#F59E0B' : '#EF4444';
        frame.style.transition = 'none';
        frame.style.borderColor = color;
        frame.style.boxShadow = `0 0 0 4000px rgba(0,0,0,0.3), 0 0 30px 8px ${color}`;
        setTimeout(() => {
            frame.style.transition = 'all 0.4s ease';
            frame.style.borderColor = '#3B82F6';
            frame.style.boxShadow = '0 0 0 4000px rgba(0,0,0,0.3)';
        }, 350);
    }
    function notifyResult(type) {
        // type: 'success' | 'duplicate' | 'error'
        playBeep(type);
        flashFrame(type);
        if (type === 'success') vibrateDevice([80]);
        else if (type === 'duplicate') vibrateDevice([60, 60, 60]);
        else vibrateDevice([150, 80, 150]);
    }

    async function registerAttendanceByDocument(studentDoc) {
        const statusEl = document.getElementById('qr-status-msg');
        try {
            // Buscar estudiante en caché por número de documento (evita query a Firestore)
            let sData = dataCache.students.find(s => s.document === studentDoc);
            if (!sData) {
                statusEl.textContent = `❌ Documento no encontrado: ${studentDoc}`;
                statusEl.className = 'status-msg status-error';
                notifyResult('error');
                return;
            }
            const name = sData.name;
            const today = new Date().toISOString().slice(0,10);
            const key = `${studentDoc}_${today}`;
            if (scannedToday.has(key)) {
                statusEl.textContent = `⚠️ ${name} ya registró asistencia hoy`;
                statusEl.className = 'status-msg status-error';
                notifyResult('duplicate');
                return;
            }
            // Buscar tribu del estudiante usando caché
            let tribeId = null, tribeName = null;
            const tribe = findStudentTribe(sData.id, name, sData.course);
            if (tribe) { tribeId = tribe.id; tribeName = tribe.name; }
            const result = await recordAttendance(studentDoc, name, tribeId, tribeName, sData.course, sData.id);
            if (result.duplicate) {
                statusEl.textContent = `⚠️ ${name} ya registró asistencia hoy`;
                statusEl.className = 'status-msg status-error';
                notifyResult('duplicate');
            } else {
                const ar = result.awardResult;
                let msg = `✅ ¡${name} registrado! +1pt individual · +1🪙`;
                if (tribeName) msg += ` · +1pt a ${tribeName}`;
                if (ar?.leveledUp) msg += ` · ⬆️ ¡Subió a ${ar.levelInfo.icon} ${ar.levelInfo.name}! (+${ar.bonusCoins}🪙 bono)`;
                statusEl.textContent = msg;
                statusEl.className = 'status-msg status-success';
                notifyResult('success');
                await loadAttendanceLog();
                await renderChart();
            }
        } catch(e) {
            statusEl.textContent = `❌ Error al registrar`;
            statusEl.className = 'status-msg status-error';
            notifyResult('error');
        }
    }
    async function processQRCode(data) {
        // El QR contiene únicamente el número de documento
        await registerAttendanceByDocument(data.trim());
    }

    // QR Generator Grid
    let selectedQrDocs = new Set(); // documentos de estudiantes seleccionados para imprimir/exportar
    function updateQrSelectCount() {
        document.getElementById('qrSelectCount').textContent = `${selectedQrDocs.size} seleccionado${selectedQrDocs.size===1?'':'s'}`;
    }
    async function loadQRGeneratorGrid() {
        const grid = document.getElementById('qrGenGrid');
        const students = await getStudents(null);
        if (!students.length) { grid.innerHTML='<div style="text-align:center;color:#94A3B8;font-size:13px;padding:20px;">Sin estudiantes registrados</div>'; return; }
        grid.innerHTML = '';
        for (const s of students) {
            const docKey = s.document || s.id;
            const item = document.createElement('div');
            item.className = 'qr-gen-item' + (selectedQrDocs.has(docKey) ? ' selected' : '');
            item.title = `Ver QR de ${s.name}`;
            item.dataset.docKey = docKey;

            const check = document.createElement('input');
            check.type = 'checkbox';
            check.className = 'qr-check';
            check.checked = selectedQrDocs.has(docKey);
            check.addEventListener('click', (e) => e.stopPropagation()); // evita doble toggle con el click del item
            check.addEventListener('change', () => {
                if (check.checked) selectedQrDocs.add(docKey); else selectedQrDocs.delete(docKey);
                item.classList.toggle('selected', check.checked);
                updateQrSelectCount();
            });
            item.appendChild(check);

            const qrDiv = document.createElement('div');
            qrDiv.className = 'qr-mini';
            qrDiv.style.width = '80px'; qrDiv.style.height = '80px';
            item.appendChild(qrDiv);
            const label = document.createElement('div');
            label.className = 'qr-label';
            label.textContent = s.name.split(' ').slice(0,2).join(' ');
            const doc_ = document.createElement('div');
            doc_.className = 'qr-doc';
            doc_.textContent = s.document||courseNames[s.course]||s.course;
            item.appendChild(label); item.appendChild(doc_);

            // Clic en cualquier parte de la tarjeta también alterna la selección
            item.addEventListener('click', () => { check.checked = !check.checked; check.dispatchEvent(new Event('change')); });

            grid.appendChild(item);
            // Generar QR
            try {
                new window.QRCode(qrDiv, {
                    text: s.document || s.id,
                    width: 80, height: 80,
                    colorDark: "#1E293B", colorLight: "#ffffff",
                    correctLevel: window.QRCode.CorrectLevel.H
                });
            } catch(e) {}
        }
    }
    document.getElementById('qrSelectAllBtn').onclick = (e) => {
        e.preventDefault();
        document.querySelectorAll('#qrGenGrid .qr-gen-item').forEach(item => {
            selectedQrDocs.add(item.dataset.docKey);
            item.classList.add('selected');
            const cb = item.querySelector('.qr-check'); if (cb) cb.checked = true;
        });
        updateQrSelectCount();
    };
    document.getElementById('qrSelectNoneBtn').onclick = (e) => {
        e.preventDefault();
        selectedQrDocs.clear();
        document.querySelectorAll('#qrGenGrid .qr-gen-item').forEach(item => {
            item.classList.remove('selected');
            const cb = item.querySelector('.qr-check'); if (cb) cb.checked = false;
        });
        updateQrSelectCount();
    };

    // Imprimir QR
    document.getElementById("printQrsBtn").onclick = async () => {
        const courseFilter = document.getElementById('printCourseFilter').value; // '' = todos agrupados
        let students = await getStudents(null);
        if (selectedQrDocs.size > 0) {
            students = students.filter(s => selectedQrDocs.has(s.document || s.id));
        } else if (courseFilter) {
            students = students.filter(s => String(s.course) === courseFilter);
        }
        if (!students.length) { showToast(selectedQrDocs.size > 0 ? "Los estudiantes seleccionados no se encontraron" : (courseFilter ? "No hay estudiantes en ese curso" : "No hay estudiantes para imprimir"),"error"); return; }

        // Agrupar por curso y ordenar alfabéticamente dentro de cada curso
        const courseOrder = ['6','7','8','9','10','11'];
        const grouped = {};
        students.forEach(s => {
            const c = String(s.course);
            (grouped[c] = grouped[c] || []).push(s);
        });
        Object.keys(grouped).forEach(c => grouped[c].sort((a,b) => a.name.localeCompare(b.name)));
        const coursesToRender = courseOrder.filter(c => grouped[c] && grouped[c].length);

        const printArea = document.getElementById('printArea');
        printArea.style.display = 'block';
        printArea.innerHTML = `
        <style>
            @media print {
                body * { visibility:hidden; }
                #printArea, #printArea * { visibility:visible; }
                #printArea { position:static !important; width:100%; }
                .print-course-section { page-break-after: always; }
                .print-course-section:last-child { page-break-after: auto; }
            }
            .print-course-title { font-family:sans-serif; font-weight:800; font-size:16px; color:#1E293B; padding:14px 4px 6px; border-bottom:2px solid #7C3AED; margin:0 20px 10px; }
            .print-grid { display: flex; flex-wrap: wrap; gap: 10px; padding: 0 20px 20px; }
            .print-card { flex: 0 0 calc(25% - 8px); max-width: calc(25% - 8px); box-sizing: border-box; border: 2px solid #E2E8F0; border-radius: 12px; padding: 12px; text-align: center; page-break-inside: avoid; break-inside: avoid; }
            .print-name { font-weight: 700; font-size: 12px; margin-top: 6px; font-family: sans-serif; }
            .print-doc { color: #94A3B8; font-size: 10px; font-family: sans-serif; }
            .print-course { background: #DBEAFE; color: #2563EB; border-radius: 10px; padding: 2px 8px; font-size: 10px; display: inline-block; margin-top: 4px; font-family: sans-serif; font-weight: bold; }
        </style>`;

        for (const c of coursesToRender) {
            const list = grouped[c];
            const section = document.createElement('div');
            section.className = 'print-course-section';

            const title = document.createElement('div');
            title.className = 'print-course-title';
            title.textContent = `Curso ${courseNames[c] || c}° — ${list.length} estudiante${list.length===1?'':'s'}`;
            section.appendChild(title);

            const grid = document.createElement('div');
            grid.className = 'print-grid';
            section.appendChild(grid);
            printArea.appendChild(section);

            for (const s of list) {
                const card = document.createElement('div');
                card.className = 'print-card';

                const qrDiv = document.createElement('div');
                qrDiv.style.margin = '0 auto';
                qrDiv.style.width = '90px'; qrDiv.style.height = '90px';
                card.appendChild(qrDiv);

                const nameEl = document.createElement('div');
                nameEl.className = 'print-name';
                nameEl.textContent = s.name.split(' ').slice(0,3).join(' ');
                card.appendChild(nameEl);

                const docEl = document.createElement('div');
                docEl.className = 'print-doc';
                docEl.textContent = s.document || '';
                card.appendChild(docEl);

                const courseEl = document.createElement('div');
                courseEl.className = 'print-course';
                courseEl.textContent = courseNames[s.course] || s.course;
                card.appendChild(courseEl);

                grid.appendChild(card);

                // Generar el QR DESPUÉS de insertar qrDiv en el DOM real
                try {
                    new window.QRCode(qrDiv, { text: String(s.document || s.id), width:90, height:90, colorDark:"#1E293B", colorLight:"#ffffff", correctLevel:window.QRCode.CorrectLevel.H });
                } catch(e) { console.error('Error generando QR para', s.name, e); }
            }
        }
        // Esperar a que todos los canvas/imgs terminen de pintarse antes de imprimir
        setTimeout(() => {
            window.print();
            setTimeout(() => { printArea.style.display='none'; printArea.innerHTML=''; }, 300);
        }, 600);
    };

    // ===== DESCARGAR CARNÉS COMO PDF (posiciones calculadas, sin depender de paginación del navegador) =====
    document.getElementById("downloadQrsPdfBtn").onclick = async () => {
        const courseFilter = document.getElementById('printCourseFilter').value;
        let students = await getStudents(null);
        if (selectedQrDocs.size > 0) {
            students = students.filter(s => selectedQrDocs.has(s.document || s.id));
        } else if (courseFilter) {
            students = students.filter(s => String(s.course) === courseFilter);
        }
        if (!students.length) { showToast(selectedQrDocs.size > 0 ? "Los estudiantes seleccionados no se encontraron" : (courseFilter ? "No hay estudiantes en ese curso" : "No hay estudiantes para exportar"),"error"); return; }

        const courseOrder = ['6','7','8','9','10','11'];
        const grouped = {};
        students.forEach(s => { const c = String(s.course); (grouped[c] = grouped[c] || []).push(s); });
        Object.keys(grouped).forEach(c => grouped[c].sort((a,b) => a.name.localeCompare(b.name)));
        const coursesToRender = courseOrder.filter(c => grouped[c] && grouped[c].length);

        const btn = document.getElementById('downloadQrsPdfBtn');
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> Generando PDF...';

        // Contenedor invisible donde renderizamos temporalmente cada QR para poder leerlo como imagen
        const hidden = document.createElement('div');
        hidden.style.position = 'fixed'; hidden.style.left = '-9999px'; hidden.style.top = '0';
        document.body.appendChild(hidden);

        try {
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
            const pageH = 297, marginX = 10, marginY = 12;
            const cols = 4, cardW = 44.5, cardH = 50, gap = 4;
            const qrSize = 30;

            let firstPage = true;
            for (const c of coursesToRender) {
                const list = grouped[c];
                if (!firstPage) pdf.addPage();
                firstPage = false;

                let col = 0, y = marginY;
                pdf.setFontSize(13); pdf.setFont(undefined, 'bold'); pdf.setTextColor(30,41,59);
                pdf.text(`Curso ${courseNames[c] || c}° — ${list.length} estudiante${list.length===1?'':'s'}`, marginX, y);
                y += 8;

                for (let i = 0; i < list.length; i++) {
                    const s = list[i];

                    // Generar el QR en el contenedor oculto y leerlo como imagen
                    const qrDiv = document.createElement('div');
                    hidden.appendChild(qrDiv);
                    try {
                        new window.QRCode(qrDiv, { text: String(s.document || s.id), width:200, height:200, colorDark:"#1E293B", colorLight:"#ffffff", correctLevel:window.QRCode.CorrectLevel.H });
                    } catch(e) { console.error('Error generando QR para', s.name, e); }
                    await new Promise(r => setTimeout(r, 15));
                    const canvasEl = qrDiv.querySelector('canvas');
                    const imgData = canvasEl ? canvasEl.toDataURL('image/png') : (qrDiv.querySelector('img')?.src || null);
                    hidden.removeChild(qrDiv);

                    const x = marginX + col * (cardW + gap);

                    pdf.setDrawColor(226,232,240);
                    pdf.roundedRect(x, y, cardW, cardH, 2, 2);

                    if (imgData) {
                        const qrX = x + (cardW - qrSize) / 2;
                        pdf.addImage(imgData, 'PNG', qrX, y + 3, qrSize, qrSize);
                    }

                    const nameShort = s.name.split(' ').slice(0, 3).join(' ');
                    pdf.setFontSize(8); pdf.setFont(undefined, 'bold'); pdf.setTextColor(30,41,59);
                    const nameLines = pdf.splitTextToSize(nameShort, cardW - 4);
                    pdf.text(nameLines, x + cardW / 2, y + qrSize + 8, { align: 'center' });

                    pdf.setFontSize(7); pdf.setFont(undefined, 'normal'); pdf.setTextColor(148,163,184);
                    pdf.text(String(s.document || ''), x + cardW / 2, y + qrSize + 8 + (nameLines.length * 3.2) + 3, { align: 'center' });

                    col++;
                    if (col >= cols) {
                        col = 0;
                        y += cardH + gap;
                        // Si la siguiente fila ya no cabe en la página, saltar de página
                        if (y + cardH > pageH - marginY && i < list.length - 1) {
                            pdf.addPage();
                            y = marginY;
                            pdf.setFontSize(11); pdf.setFont(undefined, 'italic'); pdf.setTextColor(100,116,139);
                            pdf.text(`Curso ${courseNames[c] || c}° (continuación)`, marginX, y);
                            y += 8;
                        }
                    }
                }
            }

            document.body.removeChild(hidden);
            pdf.save('carnes_qr_ethykos.pdf');
            showToast('✅ PDF generado','success');
        } catch(e) {
            console.error(e);
            document.body.contains(hidden) && document.body.removeChild(hidden);
            showToast('Error al generar el PDF','error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    };

    // ===== HISTORIAL DE ASISTENCIA =====
    let activeHistoryFilters = []; // ej: ['student'], ['date'], ['student','course'], etc.
    let historyStudentsCache = null;

    document.getElementById("historySectionBtn").onclick = async () => {
        activeHistoryFilters = [];
        document.querySelectorAll('.filter-type-card').forEach(c => c.classList.remove('active'));
        openModal("historyFilterTypeModal");
        // NO llamar autoRepairAttendance() directamente aquí:
        // scheduleRepair() ya se ejecuta después de cambios en tribus,
        // y el lock previene ejecuciones concurrentes.
    };

    // Auto-reparación silenciosa: repara tribeId faltante y puntos de tribu pendientes
    // Usa lock para evitar ejecuciones concurrentes que dupliquen puntos
    async function autoRepairAttendance(forceNotify) {
        if (repairRunning) { if (forceNotify) showToast('Ya hay una reparación en curso, espera un momento...', ''); return; }
        repairRunning = true;
        if (repairTimeout) { clearTimeout(repairTimeout); repairTimeout = null; }
        try {
            // Usar caché en lugar de leer de Firestore
            const records = getCachedAttendance();

            // 1) Reparar registros sin tribeId que sí tienen estudiante en una tribu
            const missingTribe = records.filter(r => !r.tribeId && r.studentDoc);
            let tribeFixed = 0;
            if (missingTribe.length > 0) {
                const allStudents = getCachedStudents();
                const byDoc = {};
                allStudents.forEach(s => { if (s.document) byDoc[s.document] = s; });

                for (const r of missingTribe) {
                    const student = byDoc[r.studentDoc];
                    if (!student) continue;
                    const tribe = findStudentTribe(student.id, r.studentName, student.course);
                    if (tribe) {
                        await updateDoc(doc(db, "attendance", r.id), {
                            tribeId: tribe.id,
                            tribeName: tribe.name
                        });
                        cacheUpdateAttendance(r.id, { tribeId: tribe.id, tribeName: tribe.name });
                        tribeFixed++;
                    }
                }
            }

            // 2) Aplicar puntos de tribu pendientes.
            // Solo procesa registros marcados EXPLÍCITAMENTE con tribePointsAwarded === false.
            // Los registros sin el campo (undefined) se consideran ya procesados y solo se
            // marcan como true para evitar que la próxima ejecución los vuelva a tocar.
            const records_with_tribe = records.filter(r => r.tribeId);
            const pendingPts = records_with_tribe.filter(r => r.tribePointsAwarded === false);
            const unmarked = records_with_tribe.filter(r => r.tribePointsAwarded === undefined || r.tribePointsAwarded === null);

            // Marcar silenciosamente los registros sin el campo (ya tienen su punto, solo falta la marca)
            for (const r of unmarked) {
                try {
                    await updateDoc(doc(db, "attendance", r.id), { tribePointsAwarded: true });
                    cacheUpdateAttendance(r.id, { tribePointsAwarded: true });
                } catch(e) {}
            }

            let ptsFixed = 0;
            for (const r of pendingPts) {
                try {
                    await updatePoints(r.tribeId, 1, 'repair');
                    await updateDoc(doc(db, "attendance", r.id), { tribePointsAwarded: true });
                    cacheUpdateAttendance(r.id, { tribePointsAwarded: true });
                    ptsFixed++;
                } catch(e) {}
            }

            // Notificar solo si hubo cambios (o siempre, si se pidió explícitamente)
            if (tribeFixed > 0 || ptsFixed > 0) {
                let msg = 'Auto-reparación: ';
                const parts = [];
                if (tribeFixed > 0) parts.push(`${tribeFixed} registro(s) con tribu asignada`);
                if (ptsFixed > 0) parts.push(`${ptsFixed} punto(s) de tribu aplicado(s)`);
                msg += parts.join(', ');
                showToast('🔧 ' + msg, 'success');
                await renderTribes();
                await renderChart();
            } else if (forceNotify) {
                showToast('✅ Todo en orden, no había nada pendiente por reparar', 'success');
            }
        } catch(e) {
            console.error('Error en autoRepairAttendance:', e);
            if (forceNotify) showToast('Error al reparar. Revisa la consola para más detalle.', 'error');
        } finally {
            repairRunning = false;
            // Si hubo una petición de reparación mientras esta estaba corriendo, ejecutarla ahora
            if (repairPending) {
                repairPending = false;
                scheduleRepair();
            }
        }
    }

    document.getElementById("closeHistoryFilterTypeBtn").onclick = () => closeModal("historyFilterTypeModal");

    document.querySelectorAll('.filter-type-card').forEach(card => {
        card.addEventListener('click', () => {
            card.classList.toggle('active');
            const type = card.dataset.filter;
            if (card.classList.contains('active')) {
                if (!activeHistoryFilters.includes(type)) activeHistoryFilters.push(type);
            } else {
                activeHistoryFilters = activeHistoryFilters.filter(f => f !== type);
            }
        });
    });

    // Doble clic / clic + Enter no aplica aquí; usamos un botón implícito: al elegir, mostramos botón continuar
    // Para mantenerlo simple, agregamos un botón "Ver historial" dinámico
    (function addContinueButton() {
        const modalContent = document.querySelector('#historyFilterTypeModal .modal-content');
        const btn = document.createElement('button');
        btn.className = 'modal-save';
        btn.style.width = '100%';
        btn.style.marginTop = '12px';
        btn.innerHTML = '<i class="fas fa-search"></i> Ver Historial';
        btn.onclick = async () => {
            if (!activeHistoryFilters.length) { showToast('Selecciona al menos un tipo de filtro', 'error'); return; }
            closeModal('historyFilterTypeModal');
            await openHistoryResultsModal();
        };
        modalContent.insertBefore(btn, modalContent.querySelector('.modal-buttons'));
    })();

    async function openHistoryResultsModal() {
        // Mostrar/ocultar campos según filtros activos
        document.getElementById('hf-student-wrap').style.display = activeHistoryFilters.includes('student') ? 'flex' : 'none';
        document.getElementById('hf-course-wrap').style.display = activeHistoryFilters.includes('course') ? 'flex' : 'none';
        document.getElementById('hf-datefrom-wrap').style.display = activeHistoryFilters.includes('date') ? 'flex' : 'none';
        document.getElementById('hf-dateto-wrap').style.display = activeHistoryFilters.includes('date') ? 'flex' : 'none';

        if (activeHistoryFilters.includes('student') && !historyStudentsCache) {
            historyStudentsCache = await getStudents(null);
            const sel = document.getElementById('hf-student');
            sel.innerHTML = '<option value="">Todos</option>' + historyStudentsCache.map(s =>
                `<option value="${escapeHtml(s.document||'')}">${escapeHtml(s.name)} (${courseNames[s.course]||s.course})</option>`
            ).join('');
        }

        openModal('historyResultsModal');
        await runHistoryQuery();
    }

    async function runHistoryQuery() {
        const filters = {};
        if (activeHistoryFilters.includes('student')) {
            const v = document.getElementById('hf-student').value;
            if (v) filters.studentDoc = v;
        }
        if (activeHistoryFilters.includes('course')) {
            const v = document.getElementById('hf-course').value;
            if (v) filters.course = v;
        }
        if (activeHistoryFilters.includes('date')) {
            const from = document.getElementById('hf-dateFrom').value;
            const to = document.getElementById('hf-dateTo').value;
            if (from) filters.dateFrom = from;
            if (to) filters.dateTo = to;
        }

        const tbody = document.getElementById('historyTableBody');
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:#94A3B8;"><i class="fas fa-spinner fa-pulse"></i> Cargando...</td></tr>';

        const records = await getAttendanceHistory(filters);

        document.getElementById('historyResultsCount').textContent = `${records.length} registro${records.length===1?'':'s'} encontrado${records.length===1?'':'s'}`;

        if (!records.length) {
            tbody.innerHTML = '<tr><td colspan="5"><div class="history-empty-msg"><i class="fas fa-inbox" style="font-size:24px;display:block;margin-bottom:8px;"></i>No hay registros con estos filtros</div></td></tr>';
            return;
        }

        tbody.innerHTML = records.map(r => `
            <tr>
                <td>${escapeHtml(r.date||'')}</td>
                <td>${escapeHtml(r.studentName||'')}</td>
                <td>${escapeHtml(r.studentDoc||'')}</td>
                <td>${r.course?courseNames[r.course]||r.course:'<span class="ht-empty">—</span>'}</td>
                <td>${r.tribeName?`<span class="ht-tribe">🏹 ${escapeHtml(r.tribeName)}</span>`:'<span class="ht-empty">Sin tribu</span>'}</td>
            </tr>`).join('');
    }

    document.getElementById('hf-student').addEventListener('change', runHistoryQuery);
    document.getElementById('hf-course').addEventListener('change', runHistoryQuery);
    document.getElementById('hf-dateFrom').addEventListener('change', runHistoryQuery);
    document.getElementById('hf-dateTo').addEventListener('change', runHistoryQuery);

    document.getElementById('hf-clearBtn').onclick = () => {
        document.getElementById('hf-student').value = '';
        document.getElementById('hf-course').value = '';
        document.getElementById('hf-dateFrom').value = '';
        document.getElementById('hf-dateTo').value = '';
        runHistoryQuery();
    };

    document.getElementById('hf-auditBtn').onclick = async () => {
        const btn = document.getElementById('hf-auditBtn');
        const box = document.getElementById('auditResultBox');
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> Auditando...';
        box.style.display = 'none';
        try {
            // Se lee directo de Firestore (no del caché local) a propósito: la auditoría
            // debe ser una verificación independiente. Si comparara el caché contra sí
            // mismo, nunca detectaría una desincronización entre el caché y la base real.
            const tribesSnap = await getDocs(collection(db, "tribes"));
            const allTribesRaw = tribesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
            const attSnap = await getDocs(collection(db, "attendance"));
            const allAttendance = attSnap.docs.map(d => d.data());

            // 1) Detectar tribus con nombre duplicado (posible causa de confusión de puntos)
            const nameCounts = {};
            allTribesRaw.forEach(t => { const key = `${t.name}__${t.course || t.grade}`; nameCounts[key] = (nameCounts[key]||0) + 1; });
            const duplicateNames = Object.entries(nameCounts).filter(([,c]) => c > 1).map(([k]) => k.split('__')[0]);

            // 2) Contar asistencias por tribeId y comparar contra el campo "points" actual
            const attCountByTribe = {};
            allAttendance.forEach(r => { if (r.tribeId) attCountByTribe[r.tribeId] = (attCountByTribe[r.tribeId]||0) + 1; });

            const mismatches = allTribesRaw
                .map(t => ({ ...t, attCount: attCountByTribe[t.id] || 0 }))
                .filter(t => (t.points||0) !== t.attCount);

            let html = `<div style="font-weight:700;color:#0E7490;margin-bottom:6px;"><i class="fas fa-magnifying-glass-chart"></i> Resultado de la auditoría</div>`;
            html += `<div>Tribus revisadas: <strong>${allTribesRaw.length}</strong> · Registros de asistencia totales: <strong>${allAttendance.length}</strong></div>`;

            if (duplicateNames.length) {
                html += `<div style="margin-top:8px;color:#DC2626;"><strong>⚠️ Nombres de tribu duplicados</strong> (mismo nombre y curso en más de un documento): ${duplicateNames.map(n=>escapeHtml(n)).join(', ')}. Esto puede hacer parecer que una tribu tiene más/menos puntos de los que realmente le corresponden si se confunden entre sí.</div>`;
            } else {
                html += `<div style="margin-top:8px;color:#059669;">✅ No se encontraron tribus con nombres duplicados.</div>`;
            }

            if (mismatches.length) {
                html += `<div style="margin-top:8px;color:#DC2626;"><strong>⚠️ Puntos que no cuadran con la asistencia registrada:</strong></div>`;
                html += mismatches.map(t => {
                    const courseVal = t.course || t.grade;
                    const courseLabel = courseVal ? (courseNames[courseVal] || courseVal + '°') : 'Sin curso';
                    const diff = (t.points||0) - t.attCount;
                    return `<div style="margin-left:10px;">• <strong>${escapeHtml(t.name)}</strong> (${escapeHtml(String(courseLabel))}): puntos actuales = ${t.points||0}, asistencias registradas = ${t.attCount} <span style="color:#94A3B8;">(diferencia: ${diff > 0 ? '+' : ''}${diff})</span></div>`;
                }).join('');
                html += `<div style="margin-top:8px;color:#64748B;">Nota: esta comparación asume que la asistencia es la única fuente de puntos. Si has usado los botones manuales +1/+3/+5 en las tarjetas de tribu, esos también generan diferencia aquí (no es necesariamente un error).</div>`;
            } else {
                html += `<div style="margin-top:8px;color:#059669;">✅ Los puntos de todas las tribus cuadran exactamente con su número de asistencias registradas.</div>`;
            }

            box.innerHTML = html;
            box.style.display = 'block';
        } catch(e) {
            console.error(e);
            showToast('Error al ejecutar la auditoría', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    };

    document.getElementById('historyBackBtn').onclick = () => {
        closeModal('historyResultsModal');
        openModal('historyFilterTypeModal');
    };
    document.getElementById('closeHistoryResultsBtn').onclick = () => closeModal('historyResultsModal');

    document.getElementById('hf-forceRepairBtn').onclick = async () => {
        const btn = document.getElementById('hf-forceRepairBtn');
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> Reparando...';
        try {
            await autoRepairAttendance(true);
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    };

    document.getElementById('hf-resetTribePtsBtn').onclick = async () => {
        if (!confirm('Esto pondrá en 0 los puntos de TODAS las tribus, sin borrar ningún registro de asistencia. Luego puedes usar "Reparar asistencia/puntos de tribu ahora" para recalcularlos correctamente. ¿Continuar?')) return;
        if (!confirm('Confirma: se resetean a 0 los puntos de todas las tribus. ¿Estás seguro?')) return;
        const btn = document.getElementById('hf-resetTribePtsBtn');
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> Reseteando...';
        try {
            const tribesSnap = await getDocs(collection(db, "tribes"));
            for (const t of tribesSnap.docs) {
                await updateDoc(doc(db, "tribes", t.id), { points: 0 });
                cacheUpdateTribe(t.id, { points: 0 });
            }
            // Marcar todos los registros de asistencia como pendientes de reasignación de puntos
            const attSnap = await getDocs(collection(db, "attendance"));
            for (const d of attSnap.docs) {
                if (d.data().tribeId) {
                    await updateDoc(doc(db, "attendance", d.id), { tribePointsAwarded: false });
                    cacheUpdateAttendance(d.id, { tribePointsAwarded: false });
                }
            }
            showToast(`✅ Puntos de ${tribesSnap.docs.length} tribus reseteados a 0. Ahora usa "Reparar asistencia/puntos de tribu ahora".`, 'success');
            await renderTribes();
            await renderChart();
        } catch(e) {
            console.error(e);
            showToast('Error al resetear los puntos', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    };

    // ===== REWARDS CATALOG (editable, guardado en Firestore) =====
    // Catálogo original, usado solo una vez como semilla si la colección "rewards" está vacía.
    const REWARDS_SEED = [
        { id:'pc',       icon:'💻', name:'Cambiar de computador',              desc:'Cambia al PC disponible que prefieras en la próxima clase.',          cost:15 },
        { id:'turn',     icon:'🔄', name:'Cambiar turno de actividad',         desc:'Modifica tu turno de participación en la siguiente actividad.',       cost:20 },
        { id:'order',    icon:'📋', name:'Elegir orden de participación',      desc:'Decides el orden en que participan las tribus en la próxima misión.', cost:25 },
        { id:'chest',    icon:'📦', name:'Abrir Cofre Misterioso',             desc:'¡Sorpresa! El profe decide qué contiene. Puede ser algo genial.',     cost:30 },
        { id:'plus2',    icon:'➕', name:'+2 puntos a una actividad',           desc:'Suma 2 puntos extra a tu nota en una actividad a tu elección.',       cost:20 },
        { id:'plus3',    icon:'➕', name:'+3 puntos a una actividad',           desc:'Suma 3 puntos extra a tu nota en una actividad a tu elección.',       cost:30 },
        { id:'grade',    icon:'📈', name:'Mejorar tu calificación',            desc:'El profe revisará una actividad para mejorar tu calificación.',       cost:40 },
        { id:'double',   icon:'🌀', name:'Duplicar monedas siguiente misión',  desc:'Gana el doble de 🪙 en la próxima actividad donde obtengas monedas.', cost:25 },
        { id:'gift',     icon:'🎁', name:'Otorgar 10 pts a un compañero',      desc:'Regala 10 puntos de nivel a un compañero de tu elección.',            cost:15 },
        { id:'recover',  icon:'🛡️', name:'Recuperar hasta 5 pts perdidos',    desc:'Recupera hasta 5 puntos de nivel que hayas perdido recientemente.',   cost:20 },
        { id:'time',     icon:'⏰', name:'Tiempo extra para entregar',         desc:'5 minutos adicionales para entregar una actividad o tarea.',          cost:35 },
        { id:'early',    icon:'🚪', name:'Salir más temprano de clase',        desc:'Con permiso del profe, puedes salir unos minutos antes al final.',    cost:50 },
    ];
    let REWARDS = []; // catálogo vigente, cargado desde Firestore
    let rewardsCatalogLoaded = false;

    async function loadRewardsCatalog(force) {
        if (rewardsCatalogLoaded && !force) return REWARDS;
        const snap = await getDocs(collection(db, "rewards"));
        if (snap.empty) {
            // Primera vez: sembrar con el catálogo original, conservando los mismos IDs
            for (const r of REWARDS_SEED) {
                await setDoc(doc(db, "rewards", r.id), { icon:r.icon, name:r.name, desc:r.desc, cost:r.cost, createdAt: serverTimestamp() });
            }
            REWARDS = REWARDS_SEED.map(r => ({ ...r }));
        } else {
            REWARDS = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (a.cost||0)-(b.cost||0));
        }
        rewardsCatalogLoaded = true;
        return REWARDS;
    }
    async function addRewardDoc(data) {
        const ref = await addDoc(collection(db, "rewards"), { ...data, createdAt: serverTimestamp() });
        return ref.id;
    }
    async function updateRewardDoc(id, data) {
        await updateDoc(doc(db, "rewards", id), data);
    }
    async function deleteRewardDoc(id) {
        await deleteDoc(doc(db, "rewards", id));
    }

    async function updateStudentRewardPoints(studentId, delta, source) {
        // Usar caché para evitar lectura a Firestore cada vez
        const student = dataCache.students.find(s => s.id === studentId);
        if (!student) return null;
        const current = student.rewardPoints || 0;
        const updated = Math.max(0, current + delta);
        student.rewardPoints = updated;
        saveCacheToLocal();
        await updateDoc(doc(db, "students", studentId), { rewardPoints: updated });
        logPointsChange('coins', studentId, student.name, delta, updated, source || 'manual');
        return updated;
    }
    async function recordRedemption(studentId, studentName, rewardId, rewardName, cost) {
        await addDoc(collection(db, "redemptions"), {
            studentId, studentName, rewardId, rewardName, cost,
            date: new Date().toISOString().slice(0,10),
            timestamp: serverTimestamp()
        });
    }
    async function getRedemptions() {
        try {
            const snap = await getDocs(collection(db, "redemptions"));
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            return list.sort((a,b) => (b.timestamp?.seconds||0)-(a.timestamp?.seconds||0));
        } catch(e) { return []; }
    }

    // ===== SHOP LOGIC =====
    let shopStudentCache = null;
    document.getElementById('shopBtn').onclick = async () => {
        openModal('shopModal');
        await loadRewardsCatalog();
        await loadShopStudents();
        renderRewardsGrid(null);
    };
    document.getElementById('closeShopBtn').onclick = () => closeModal('shopModal');

    document.querySelectorAll('.shop-tab-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            document.querySelectorAll('.shop-tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.shop-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.stab).classList.add('active');
            if (btn.dataset.stab === 'shopHistoryPanel') await loadRedemptionHistory();
            if (btn.dataset.stab === 'shopManagePanel') renderRewardsManageList();
        });
    });

    async function loadShopStudents() {
        shopStudentCache = await getStudents(null);
        const sel = document.getElementById('shopStudentSelect');
        sel.innerHTML = '<option value="">— Selecciona un estudiante —</option>'
            + shopStudentCache.map(s =>
                `<option value="${s.id}">${escapeHtml(s.name)} (${courseNames[s.course]||s.course})</option>`
            ).join('');
    }

    document.getElementById('shopStudentSelect').addEventListener('change', function() {
        const s = shopStudentCache?.find(x => x.id === this.value);
        const info = document.getElementById('shopStudentInfo');
        if (!s) { info.classList.remove('visible'); renderRewardsGrid(null); return; }
        info.classList.add('visible');
        const lvl = getLevelInfo(s.individualPoints);
        document.getElementById('shopLevelText').textContent = `${lvl.icon} ${lvl.name} · ${lvl.points} pts de nivel`;
        document.getElementById('shopBalance').textContent = `${s.rewardPoints||0} 🪙`;
        renderRewardsGrid(s);
    });

    function renderRewardsGrid(student) {
        const grid = document.getElementById('rewardsGrid');
        if (!student) {
            grid.innerHTML = '<div style="color:#94A3B8;text-align:center;padding:30px;grid-column:1/-1;">Selecciona un estudiante para ver las recompensas disponibles</div>';
            return;
        }
        const balance = student.rewardPoints || 0;
        const today = new Date().toISOString().slice(0,10);
        const activeRewards = REWARDS.map(r =>
            (r.special && r.specialExpiry && r.specialExpiry < today) ? {...r, special:false, specialCost:null} : r
        );
        const sorted = [...activeRewards.filter(r=>r.special), ...activeRewards.filter(r=>!r.special)];
        grid.innerHTML = sorted.map(r => {
            const effectiveCost = r.special && r.specialCost ? r.specialCost : r.cost;
            const canAfford = balance >= effectiveCost;
            const specialTag = r.special ? `<div class="reward-special-tag">⚡ Especial${r.specialExpiry ? ' · hasta '+r.specialExpiry : ''}</div>` : '';
            const specialMsg = r.special && r.specialMsg ? `<div style="font-size:11px;color:#D97706;font-weight:600;margin-bottom:4px;">💬 ${escapeHtml(r.specialMsg)}</div>` : '';
            const costHtml = r.special && r.specialCost
                ? `<span style="text-decoration:line-through;color:#94A3B8;font-size:11px;">🪙${r.cost}</span> <span style="color:#D97706;font-weight:700;">🪙${r.specialCost}</span>`
                : `🪙 ${effectiveCost} monedas`;
            return `<div class="reward-card ${canAfford?'':'cant-afford'}${r.special?' special':''}">
                ${specialTag}
                <div class="reward-icon">${r.icon}</div>
                <div class="reward-name">${escapeHtml(r.name)}</div>
                ${specialMsg}
                <div class="reward-desc">${escapeHtml(r.desc)}</div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
                    <div class="reward-cost">${costHtml}</div>
                    <button class="reward-btn" onclick="window.redeemReward('${r.id}','${student.id}','${escapeHtml(student.name)}',${effectiveCost})">Canjear</button>
                </div>
            </div>`;
        }).join('');
    }

    window.redeemReward = async (rewardId, studentId, studentName, overrideCost) => {
        const reward = REWARDS.find(r => r.id === rewardId);
        if (!reward) return;
        const effectiveCost = overrideCost || (reward.special && reward.specialCost ? reward.specialCost : reward.cost);
        if (!confirm(`¿Canjear "${reward.name}" por ${effectiveCost} 🪙 para ${studentName}?`)) return;
        try {
            const updated = await updateStudentRewardPoints(studentId, -effectiveCost, 'shop_redeem');
            if (updated === null) { showToast('Estudiante no encontrado','error'); return; }
            await recordRedemption(studentId, studentName, rewardId, reward.name, effectiveCost);
            const idx = shopStudentCache?.findIndex(s => s.id === studentId);
            if (idx >= 0) {
                shopStudentCache[idx].rewardPoints = updated;
                document.getElementById('shopBalance').textContent = `${updated} 🪙`;
                renderRewardsGrid(shopStudentCache[idx]);
            }
            showToast(`✅ Canjeado: ${reward.icon} ${reward.name}`, 'success');
        } catch(e) { showToast('Error al canjear','error'); }
    };

    // ===== GESTIÓN DEL CATÁLOGO DE RECOMPENSAS =====
    function renderRewardsManageList() {
        const list = document.getElementById('rewardsManageList');
        if (!REWARDS.length) {
            list.innerHTML = '<div style="text-align:center;color:#94A3B8;padding:20px;">No hay recompensas creadas todavía</div>';
            return;
        }
        const sorted = [...REWARDS].sort((a,b) => (a.cost||0)-(b.cost||0));
        list.innerHTML = sorted.map(r => {
            const specialBadge = r.special ? `<span class="rm-special-badge">⚡ Especial${r.specialExpiry ? ' · hasta '+r.specialExpiry : ''}</span>` : '';
            const displayCost = r.special && r.specialCost ? `<span style="text-decoration:line-through;color:#94A3B8;font-size:11px;">🪙${r.cost}</span> <span style="color:#D97706;font-weight:700;">🪙${r.specialCost}</span>` : `🪙 ${r.cost||0}`;
            return `
            <div class="reward-manage-row${r.special ? '" style="border-color:#F59E0B;background:#FFFBEB' : ''}">
                <div class="rm-icon">${escapeHtml(r.icon||'🎁')}</div>
                <div class="rm-info">
                    <div class="rm-name">${escapeHtml(r.name||'')} ${specialBadge}</div>
                    <div class="rm-desc">${escapeHtml(r.desc||'')}</div>
                    ${r.special && r.specialMsg ? `<div style="font-size:10px;color:#D97706;margin-top:2px;">💬 ${escapeHtml(r.specialMsg)}</div>` : ''}
                </div>
                <div class="rm-cost">${displayCost}</div>
                <div class="rm-actions">
                    <button onclick="window.editRewardStart('${r.id}')"><i class="fas fa-pen"></i></button>
                    <button class="rm-delete" onclick="window.deleteRewardConfirm('${r.id}')"><i class="fas fa-trash"></i></button>
                </div>
            </div>`;
        }).join('');
    }

    function showRewardForm(reward) {
        document.getElementById('rewardFormId').value = reward?.id || '';
        document.getElementById('rewardFormIcon').value = reward?.icon || '';
        document.getElementById('rewardFormName').value = reward?.name || '';
        document.getElementById('rewardFormDesc').value = reward?.desc || '';
        document.getElementById('rewardFormCost').value = reward?.cost || '';
        const isSpecial = !!(reward?.special);
        document.getElementById('rewardFormSpecial').checked = isSpecial;
        document.getElementById('rewardSpecialFields').style.display = isSpecial ? 'block' : 'none';
        document.getElementById('rewardFormSpecialCost').value = reward?.specialCost || '';
        document.getElementById('rewardFormSpecialExpiry').value = reward?.specialExpiry || '';
        document.getElementById('rewardFormSpecialMsg').value = reward?.specialMsg || '';
        document.getElementById('rewardFormWrap').style.display = 'block';
        document.getElementById('saveRewardBtn').textContent = reward ? 'Guardar cambios' : 'Crear recompensa';
    }
    function hideRewardForm() {
        document.getElementById('rewardFormWrap').style.display = 'none';
    }

    document.getElementById('newRewardBtn').onclick = () => showRewardForm(null);
    document.getElementById('cancelRewardBtn').onclick = () => hideRewardForm();
    document.getElementById('rewardFormSpecial').addEventListener('change', function() {
        document.getElementById('rewardSpecialFields').style.display = this.checked ? 'block' : 'none';
    });

    document.getElementById('saveRewardBtn').onclick = async () => {
        const id = document.getElementById('rewardFormId').value;
        const icon = document.getElementById('rewardFormIcon').value.trim() || '🎁';
        const name = document.getElementById('rewardFormName').value.trim();
        const desc = document.getElementById('rewardFormDesc').value.trim();
        const cost = parseInt(document.getElementById('rewardFormCost').value, 10);

        const special = document.getElementById('rewardFormSpecial').checked;
        const specialCost = special ? (parseInt(document.getElementById('rewardFormSpecialCost').value) || null) : null;
        const specialExpiry = special ? (document.getElementById('rewardFormSpecialExpiry').value || null) : null;
        const specialMsg = special ? (document.getElementById('rewardFormSpecialMsg').value.trim() || null) : null;

        if (!name) { showToast('Ponle un nombre a la recompensa','error'); return; }
        if (!cost || cost <= 0) { showToast('El costo debe ser un número mayor a 0','error'); return; }

        try {
            const data = { icon, name, desc, cost, special: special || false };
            if (specialCost) data.specialCost = specialCost;
            if (specialExpiry) data.specialExpiry = specialExpiry;
            if (specialMsg) data.specialMsg = specialMsg;
            if (!special) { data.specialCost = null; data.specialExpiry = null; data.specialMsg = null; }

            if (id) {
                await updateRewardDoc(id, data);
                showToast('✅ Recompensa actualizada','success');
            } else {
                await addRewardDoc(data);
                showToast('✅ Recompensa creada','success');
            }
            hideRewardForm();
            await loadRewardsCatalog(true);
            renderRewardsManageList();
        } catch(e) { showToast('Error al guardar la recompensa','error'); }
    };

    window.editRewardStart = (id) => {
        const reward = REWARDS.find(r => r.id === id);
        if (reward) showRewardForm(reward);
    };
    window.deleteRewardConfirm = async (id) => {
        const reward = REWARDS.find(r => r.id === id);
        if (!reward) return;
        if (!confirm(`¿Eliminar la recompensa "${reward.name}"? Los canjes ya realizados de esta recompensa se mantienen en el historial.`)) return;
        try {
            await deleteRewardDoc(id);
            await loadRewardsCatalog(true);
            renderRewardsManageList();
            showToast('Recompensa eliminada','');
        } catch(e) { showToast('Error al eliminar','error'); }
    };

    async function loadRedemptionHistory() {
        const list = document.getElementById('redemptionList');
        list.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-pulse"></i> Cargando...</div>';
        const records = await getRedemptions();
        if (!records.length) {
            list.innerHTML = '<div style="text-align:center;color:#94A3B8;padding:30px;">No hay canjes registrados aún</div>';
            return;
        }
        list.innerHTML = records.map(r => `
            <div class="redemption-row">
                <div>
                    <div class="r-name">${escapeHtml(r.studentName||'')}</div>
                    <div class="r-reward">${REWARDS.find(x=>x.id===r.rewardId)?.icon||''} ${escapeHtml(r.rewardName||'')}</div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <span class="r-cost">-${r.cost} 🪙</span>
                    <span class="r-date">${r.date||''}</span>
                </div>
            </div>`).join('');
    }

    // ===== RANKING =====
    let rankingCurrentCourse = 'all';
    let rankingAllStudents = [];
    let rankingTribesMap = {}; // studentId → tribeName

    document.getElementById('rankingSectionBtn').onclick = async () => {
        openModal('rankingModal');
        await loadRanking();
    };
    document.getElementById('closeRankingBtn').onclick = () => closeModal('rankingModal');

    // ── Resultados de Cuestionarios ──────────────────────────
    let quizAllResults = [];
    let quizCurrentType = 'all';
    let quizCurrentCourse = 'all';

    document.getElementById('quizSectionBtn').onclick = async () => {
        openModal('quizResultsModal');
        await loadQuizResults();
    };
    document.getElementById('closeQuizResultsBtn').onclick = () => closeModal('quizResultsModal');
    document.getElementById('closeQuizDetailBtn').onclick = () => closeModal('quizDetailModal');

    document.querySelectorAll('#quizTypeFilterBar .ranking-course-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#quizTypeFilterBar .ranking-course-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            quizCurrentType = btn.dataset.qtype;
            renderQuizResults();
        });
    });
    document.querySelectorAll('#quizCourseFilterBar .ranking-course-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#quizCourseFilterBar .ranking-course-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            quizCurrentCourse = btn.dataset.qcourse;
            renderQuizResults();
        });
    });

    async function loadQuizResults() {
        document.getElementById('quizResultsTableBody').innerHTML = '<tr><td colspan="6" style="text-align:center;">Cargando...</td></tr>';
        try {
            const q = query(collection(db, "quizResults"), orderBy("createdAt", "desc"));
            const snap = await getDocs(q);
            quizAllResults = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (e) {
            console.error('Error cargando resultados de cuestionarios:', e);
            quizAllResults = [];
        }
        renderQuizResults();
    }

    function quizTypeShortLabel(type) {
        const map = {
            'Autoevaluación de Ética': 'Autoevaluación Ética',
            'Excelencia': 'Excelencia',
            'Generosidad': 'Generosidad',
            'Cuestionario Talentos': 'Talentos'
        };
        return map[type] || type || 'N/A';
    }

    function renderQuizResults() {
        let filtered = quizAllResults;
        if (quizCurrentType !== 'all') {
            filtered = filtered.filter(r => r.quizType === quizCurrentType);
        }
        if (quizCurrentCourse !== 'all') {
            filtered = filtered.filter(r => String(r.course) === quizCurrentCourse);
        }

        document.getElementById('quizResultsCount').textContent =
            `${filtered.length} resultado${filtered.length === 1 ? '' : 's'}`;

        const tbody = document.getElementById('quizResultsTableBody');
        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#94A3B8;">Sin resultados para este filtro</td></tr>';
            return;
        }

        tbody.innerHTML = filtered.map(r => {
            const name = `${r.studentLastName || ''}, ${r.studentFirstName || ''}`.trim();
            const isTalentos = r.quizType === 'Cuestionario Talentos';
            const scoreCell = isTalentos
                ? '<span style="color:#64748B;">Ver detalle</span>'
                : `${escapeHtml(String(r.score ?? 0))} / ${escapeHtml(String(r.maxScore ?? 0))}`;
            let dateStr = 'N/A';
            try {
                dateStr = new Date(r.timestamp).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
            } catch (e) {}
            return `
                <tr>
                    <td>${escapeHtml(name) || 'N/A'}</td>
                    <td>${escapeHtml(String(r.course || 'N/A'))}</td>
                    <td>${escapeHtml(quizTypeShortLabel(r.quizType))}</td>
                    <td>${scoreCell}</td>
                    <td>${escapeHtml(dateStr)}</td>
                    <td><button class="ranking-course-btn" onclick="window.__showQuizDetail('${r.id}')">Ver</button></td>
                </tr>`;
        }).join('');
    }

    window.__showQuizDetail = function (id) {
        const r = quizAllResults.find(x => x.id === id);
        if (!r) return;
        const name = `${r.studentLastName || ''}, ${r.studentFirstName || ''}`.trim();
        document.getElementById('quizDetailTitle').textContent = `${quizTypeShortLabel(r.quizType)} — ${name}`;

        let html = '';
        const answers = r.detailedAnswers || {};
        Object.keys(answers).forEach(key => {
            const val = answers[key];
            if (val && typeof val === 'object') {
                const question = val.question || val.pregunta || key;
                const answer = val.answer ?? val.respuesta ?? val.score ?? 'N/A';
                html += `<p><strong>${escapeHtml(String(question))}:</strong> ${escapeHtml(String(answer))}</p>`;
            } else {
                html += `<p><strong>${escapeHtml(String(key))}:</strong> ${escapeHtml(String(val))}</p>`;
            }
        });
        if (r.feedback) {
            html += `<hr style="margin:12px 0;"><h4>Feedback</h4><div>${escapeHtml(String(r.feedback))}</div>`;
        }
        if (!html) html = '<p style="color:#94A3B8;">No hay detalle disponible para este resultado.</p>';
        document.getElementById('quizDetailBody').innerHTML = html;
        openModal('quizDetailModal');
    };

    document.querySelectorAll('.ranking-course-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.ranking-course-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            rankingCurrentCourse = btn.dataset.rcourse;
            renderRanking();
        });
    });

    async function loadRanking() {
        // Forzar lectura fresca desde Firestore para evitar que el caché
        // desactualizado muestre tribus vacías o estudiantes sin tribu asignada
        await loadAllData(true);
        rankingAllStudents = getCachedStudents();
        rankingTribesMap = {};
        dataCache.tribes.forEach(t => {
            (t.members || []).forEach(m => {
                if (m.studentId) rankingTribesMap[m.studentId] = t.name;
                // Fallback: si el miembro no tiene studentId, intentar vincular por nombre
                else if (m.name) {
                    const match = rankingAllStudents.find(s => s.name === m.name);
                    if (match) rankingTribesMap[match.id] = t.name;
                }
            });
        });
        renderRanking();
    }

    function renderRanking() {
        const filtered = rankingCurrentCourse === 'all'
            ? rankingAllStudents
            : rankingAllStudents.filter(s => String(s.course) === rankingCurrentCourse);

        // Orden: puntos desc, y como desempate secundario (solo visual, no de mérito) el nombre
        const sorted = [...filtered].sort((a, b) => (b.individualPoints||0) - (a.individualPoints||0) || a.name.localeCompare(b.name));

        // Posición "1224": empatados comparten posición; sin puntos (0) no hay posición de mérito
        let currentRank = 0, prevPoints = null;
        const ranked = sorted.map((s, i) => {
            const pts = s.individualPoints || 0;
            if (pts !== prevPoints) { currentRank = i + 1; prevPoints = pts; }
            return { ...s, _rank: pts > 0 ? currentRank : null };
        });

        // ── Podium (top 3 CON puntos reales) ───────────────────
        const podium = document.getElementById('rankingPodium');
        const withPoints = ranked.filter(s => s._rank !== null);
        const podiumTop = withPoints.slice(0, 3);
        if (podiumTop.length < 1) {
            podium.innerHTML = `<div class="ranking-empty" style="padding:16px;">🏁 Aún nadie tiene puntos — ¡el podio se llenará pronto!</div>`;
        }
        else {
            const podiumOrder = [podiumTop[1], podiumTop[0], podiumTop[2]].filter(Boolean); // 2do, 1ro, 3ro
            podium.innerHTML = podiumOrder.map((s) => {
                const cls = s === podiumTop[0] ? 'p1' : (s === podiumTop[1] ? 'p2' : 'p3');
                const blockH = cls === 'p1' ? 80 : cls === 'p2' ? 55 : 40;
                const medal = cls === 'p1' ? '🏆' : cls === 'p2' ? '🥈' : '🥉';
                const lvl = getLevelInfo(s.individualPoints);
                const shortName = s.name.split(' ').slice(0,2).join(' ');
                return `<div class="podium-step">
                    <div class="podium-avatar ${cls}">${lvl.icon}</div>
                    <div class="podium-name" title="${escapeHtml(s.name)}">${escapeHtml(shortName)}</div>
                    <div class="podium-pts">${s.individualPoints||0} pts</div>
                    <div class="podium-block ${cls}" style="height:${blockH}px;">${medal}</div>
                </div>`;
            }).join('');
        }

        // ── Full table ────────────────────────────────────────
        const tbody = document.getElementById('rankingTableBody');
        if (!ranked.length) {
            tbody.innerHTML = `<tr><td colspan="7"><div class="ranking-empty"><i class="fas fa-users" style="font-size:24px;display:block;margin-bottom:8px;"></i>No hay estudiantes${rankingCurrentCourse !== 'all' ? ' en este curso' : ''}</div></td></tr>`;
            return;
        }
        tbody.innerHTML = ranked.map((s) => {
            const pos = s._rank;
            const posClass = pos === 1 ? 'gold' : pos === 2 ? 'silver' : pos === 3 ? 'bronze' : 'normal';
            const posLabel = pos === null ? '—' : (pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : pos);
            const lvl = getLevelInfo(s.individualPoints);
            const tribe = rankingTribesMap[s.id] || '—';
            return `<tr>
                <td><div class="rank-pos ${posClass}">${posLabel}</div></td>
                <td style="font-weight:600;">${escapeHtml(s.name)}</td>
                <td>${courseNames[s.course]||s.course}</td>
                <td class="rank-tribe">${escapeHtml(tribe)}</td>
                <td><span class="rank-level-badge">${lvl.icon} ${lvl.name}</span></td>
                <td style="font-weight:700;color:#6D28D9;">${s.individualPoints||0}</td>
                <td><span class="rank-reward-badge">🪙 ${s.rewardPoints||0}</span></td>
            </tr>`;
        }).join('');
    }

    // ===== INIT =====
    async function initDashboard() {
        await loadAllData();
        renderCoursesNav();
        document.getElementById("selectedGrade").textContent = courseNames[currentGrade];
        await renderTribes();
        await renderChart();
        // Auto-reparar asistencia en segundo plano (silencioso, sin intervención del usuario)
        autoRepairAttendance();
    }
# Éthykos — Estado del Proyecto
**Última actualización:** 2026-08-04
**Stack:** HTML/CSS/JS vanilla · Firebase Firestore + Auth · Vercel (deploy) · GitHub (repo)
**Correo principal:** rrnewball@gmail.com · **Correo secundario:** ronald.rojas@bethshalom.edu.co

---

## Estructura del proyecto
```
Ethykos/
├── index.html          (login)
├── dashboard.html      (profesor)
├── student.html        (estudiante)
├── projector.html      (proyector — no modificado)
├── css/
│   ├── dashboard.css
│   ├── student.css
│   └── index.css
├── js/
│   ├── dashboard.js
│   ├── student.js
│   └── index.js
├── cuestionarios/
│   ├── autoevaluacion_etica.html
│   ├── excelencia.html
│   ├── generosidad.html
│   └── talentos.html
├── img/
│   ├── logo.png
│   ├── chart-bg.png
│   └── imagen-tribus.png
├── .gitignore          (incluye claveEthykos.json)
├── README.md
└── CLAUDE.md
```

## Archivos principales
| Archivo | Líneas aprox. | Estado |
|---|---|---|
| `dashboard.html` | ~200 (solo HTML) | ✅ Al día |
| `js/dashboard.js` | ~3,500 | ✅ Al día |
| `css/dashboard.css` | ~900 | ✅ Al día |
| `student.html` | ~100 (solo HTML) | ✅ Al día |
| `js/student.js` | ~1,200 | ✅ Al día |
| `css/student.css` | ~900 | ✅ Al día |
| `index.html` | ~80 (solo HTML) | ✅ Al día |
| `projector.html` | desconocido | No modificado |

---

## Reglas de Firestore actuales
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAdmin() {
      return request.auth != null && request.auth.token.email in
        ["rrnewball@gmail.com", "ronald.rojas@bethshalom.edu.co"];
    }
    match /tribes/{tribeId} {
      allow read: if request.auth != null;
      allow write: if isAdmin();
    }
    match /students/{studentId} {
      allow read: if request.auth != null;
      allow write: if isAdmin();
    }
    match /attendance/{record} {
      allow read: if request.auth != null;
      allow write: if isAdmin();
    }
    match /redemptions/{redemptionId} {
      allow read, write: if isAdmin();
    }
    match /rewards/{rewardId} {
      allow read: if request.auth != null;
      allow write: if isAdmin();
    }
    match /quizResults/{resultId} {
      allow create: if request.auth != null;
      allow read, update, delete: if isAdmin();
    }
    match /pointsLog/{logId} {
      allow read: if isAdmin();
      allow create: if isAdmin();
    }
  }
}
```

---

## Colecciones de Firestore
| Colección | Propósito |
|---|---|
| `tribes` | Equipos/tribus con miembros, puntos e identidad |
| `students` | Perfil, puntos de nivel, monedas, syllabusDelivered |
| `attendance` | Registros de asistencia (fecha, estudiante, tribu) |
| `redemptions` | Historial de canjes de recompensas |
| `rewards` | Catálogo editable de recompensas |
| `quizResults` | Resultados de cuestionarios de autoevaluación |
| `pointsLog` | Log de auditoría de todos los cambios de puntos |

---

## Sistemas implementados (funcionales)

### Autenticación y seguridad
- Login con email/password en `index.html`
- Cierre de sesión automático por inactividad (30 min) via `localStorage`
- Validación de email exacto al cargar dashboard (dos correos autorizados)
- Auth anónima para estudiantes en `student.html`
- XSS fix en `quizResults` (escaping en renderizado)

### Sistema de puntos
- **Puntos de nivel** (individual, permanentes, determinan nivel 🌱→🌟)
- **Monedas 🪙** (gastables en tienda, se otorgan en espejo con puntos de nivel)
- **Bono por subir de nivel:** nivel alcanzado × 10 monedas extra
- **Puntos de tribu:** +1 por cada asistencia del integrante
- Función central `awardLevelPoints()`: nivel + monedas + bono en una sola operación
- Campo de **motivo** al asignar puntos manualmente (registrado en log)
- Anti-doble-clic en botones de puntos de tribu

### Niveles éticos (6 niveles)
| # | Nombre | Desde | Descripción |
|---|---|---|---|
| 1 | 🌱 Aprendiz | 0 pts | Estás comenzando tu camino ético |
| 2 | 🔍 Curioso/a | 50 pts | Empiezas a hacerte preguntas importantes |
| 3 | 💭 Reflexivo/a | 120 pts | Piensas antes de actuar |
| 4 | 🤝 Comprometido/a | 220 pts | Tus acciones muestran que la ética no es solo teoría |
| 5 | 🔥 Ético/a Activo/a | 350 pts | Eres un referente |
| 6 | 🌟 Guía Ética | 500 pts | Nivel máximo |

### Asistencia
- Registro por QR (cámara, incluye selector de cámara USB)
- Registro manual (buscador autocompletar por nombre)
- Auto-reparación: asigna puntos de tribu a registros sin tribu asignada (cuando el estudiante se incorpora a una tribu después de asistir)
- `pointsAwarded: true` marca los registros que ya sumaron punto individual
- `tribePointsAwarded: false/true` controla el punto de tribu (evita doble suma)

### Catálogo de recompensas
- Editable desde dashboard (crear/editar/eliminar) en pestaña "⚙️ Gestionar"
- **Recompensas especiales/sorpresa:** checkbox para activar manualmente, costo con descuento opcional, fecha de expiración opcional, mensaje personalizado. Aparece primero en la grilla con badge dorado ⚡. Al expirar vuelve a comportarse como normal automáticamente.
- Guardado en Firestore colección `rewards`
- Primera carga: siembra 12 recompensas predeterminadas si la colección está vacía
- `student.html` lee desde Firestore (no lista hardcodeada)

### Historial y auditoría (en Historial de Asistencia)
- Filtros: por estudiante (autocompletar), curso, fecha desde/hasta, tribu
- **Auditar puntos de tribu:** compara puntos actuales vs asistencias reales en Firestore
- **Resetear puntos de tribu** (sin borrar asistencia)
- **Reparar asistencia/puntos de tribu ahora** (con feedback visible)

### Log de cambios de puntos (📜 Log de puntos en header)
- Colección `pointsLog` en Firestore
- Registra: fecha/hora, tipo (tribu/individual/monedas), nombre, delta, valor resultante, origen, motivo (si se ingresó), correo del actor
- Filtros: tipo, origen, fecha desde/hasta, búsqueda por nombre
- Orígenes registrados: `attendance`, `manual`, `manual: [motivo]`, `syllabus`, `repair`, `backfill`, `shop_redeem`, `sync_coins`

### Respaldo
- **Manual:** botón "💾 Respaldo" en header — descarga JSON de 7 colecciones
- **Automático diario:** Google Apps Script en cuenta Google del profesor
  - Incremental para `attendance` (solo registros nuevos cada día)
  - Colecciones pequeñas: lectura completa cada vez
  - Guarda en Google Drive (carpeta "Éthykos - Respaldos")
  - Mantiene 14 respaldos + `ethykos_backup_latest.json`
  - Envía correo de confirmación (✅ o ❌)
  - Fix aplicado: `private_key.replace(/\\n/g, '\n')` en `getAccessToken()`

### Portal del estudiante (student.html)
- Login por número de documento (sin contraseña)
- Muestra: nivel actual, puntos, monedas, barra de progreso, tribu, asistencias, recompensas disponibles
- **Mensajes pedagógicos:** mensaje motivador dinámico según cercanía al siguiente nivel, descripción del nivel actual, puntos exactos que faltan
- **Mapa de niveles:** cada nivel bloqueado muestra cuántos puntos faltan, descripción en cursiva
- Actualización automática de datos de tribu cada 45s (sin recargar página)
- Auth anónima automática

### Otros
- Carnés QR: generación en pantalla, selección individual, impresión agrupada por curso, exportación a PDF (jsPDF)
- Ranking: podio sin empates con 0 pts, posiciones estilo "1224", caja de búsqueda por nombre, recarga fresca al abrir
- Resultados de cuestionarios: filtros por tipo, curso, fecha, nombre
- Entrega de Syllabus: +10 pts, una sola vez, badge visual en lista de estudiantes
- Cierre automático de sesión (30 min inactividad), con aviso en login si expiró
- Selector de cámara USB para asistencia (preferencia guardada en localStorage)
- Doble confirmación al eliminar estudiante o tribu

---

## Caché local (localStorage)
- TTL: 10 minutos (`CACHE_TTL`)
- Clave: `CACHE_KEY` (contiene tribes, students, attendance + lastSync)
- Funciones: `loadAllData(forceFresh)`, `getCachedStudents()`, `getCachedTribes(grade)`
- El ranking y la auditoría siempre leen directo de Firestore (fuente independiente)
- La auditoría `autoRepairAttendance` también lee directo de Firestore

---

## Pendiente (lista priorizada)
| # | Tarea | Prioridad |
|---|---|---|
| 1 | Verificar ranking todos los cursos tras ejecutar reparación | Media |
| 2 | Correr "Completar fechas para desempate de ranking" una vez (backfill pointsUpdatedAt) | Media |

## Última sesión — completado
- Ranking: desempate justo por quién llegó primero al puntaje (`pointsUpdatedAt`) en vez de alfabético. Campo se guarda en `awardLevelPoints()` y `updateStudentPoints()` cada vez que cambian los puntos de nivel. Tooltip en la posición muestra la fecha exacta. Nuevo botón "Completar fechas para desempate de ranking" en Historial de Asistencia hace backfill desde `pointsLog` para estudiantes con puntos previos a este cambio.
- Deshacer entrega de Syllabus: badge "entregado" ahora es clicable (resta 10pts/10🪙 con confirmación). Confirmación agregada también antes de asignar por primera vez. Limitación conocida: bono de monedas por nivel no se revierte automáticamente en el undo.
- Auto-refresco extendido con patrón reutilizable `createAutoRefresh()` + `refreshCoreData()` (solo students+tribes, no attendance) a: vista principal de tribus (90s, siempre activa), Gestión de estudiantes (90s), Log de puntos (120s), Ranking (90s, ya existía). Todas se pausan con Page Visibility API cuando la pestaña no está visible, y refrescan al instante al volver.
- Sesión por pestaña (browserSessionPersistence) — cerrar sesión en una pestaña no afecta a las demás

---

## Notas operativas importantes
- **Firestore Spark (gratuito):** límite 50,000 lecturas/día. Con respaldo incremental el riesgo es bajo.
- **`student.html`** tiene **dos** bloques de código casi idénticos (dos versiones de `renderPortal`). Al editar, buscar ambas ocurrencias.
- **Puntos de tribu vs asistencia:** la auditoría espera 1 punto por asistencia. Diferencias mayores indican puntos manuales (normales) o duplicados (bug).
- **`tribePointsAwarded: false`** = pendiente de asignar punto de tribu. `undefined` = ya procesado (no sumar de nuevo).
- El campo `studentId` en los miembros de tribu es crítico — perderlo deshabilita los botones de puntos. El bug fue corregido en `openEditMemberModal`.
- El respaldo de Google Apps Script requiere el fix de `replace(/\\n/g, '\n')` en `getAccessToken()`.

# Éthykos — Estado del Proyecto
**Última actualización:** 2026-08-25
**Stack:** HTML/CSS/JS vanilla · Firebase Firestore + Auth · Vercel (deploy) · GitHub (repo)
**Correo principal:** rrnewball@gmail.com · **Correo secundario:** ronald.rojas@bethshalom.edu.co

---

## Estructura del proyecto
```
Ethykos/
├── index.html          (login + juegos/cuestionarios)
├── dashboard.html      (profesor)
├── student.html        (estudiante)
├── projector.html      (proyector)
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
| `dashboard.html` | ~210 (solo HTML) | ✅ Al día |
| `js/dashboard.js` | ~3,150 | ✅ Al día |
| `css/dashboard.css` | ~635 | ✅ Al día |
| `student.html` | ~100 (solo HTML) | ✅ Al día |
| `js/student.js` | ~1,210 | ✅ Al día |
| `css/student.css` | ~900 | Sin cambios esta sesión |
| `index.html` | ~601 (incluye juegos/cuestionarios) | ✅ Al día |
| `js/index.js` | ~90 | ✅ Al día |
| `projector.html` | ~590 | ✅ Al día (antes "no modificado") |
| `cuestionarios/*.html` (4 archivos) | variable | ✅ Al día |

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
Sin cambios esta sesión — confirmado que `onSnapshot` (lectura en tiempo real) respeta las mismas reglas `allow read` que `getDocs`, no requiere reglas adicionales.

---

## Colecciones de Firestore
| Colección | Propósito |
|---|---|
| `tribes` | Equipos/tribus con miembros, puntos e identidad |
| `students` | Perfil, puntos de nivel, monedas, syllabusDelivered |
| `attendance` | Registros de asistencia (fecha, estudiante, tribu, curso) |
| `redemptions` | Historial de canjes de recompensas |
| `rewards` | Catálogo editable de recompensas |
| `quizResults` | Resultados de cuestionarios de autoevaluación |
| `pointsLog` | Log de auditoría de todos los cambios de puntos |

---

## Sistemas implementados (funcionales)

### Autenticación y sesión (rediseñado esta sesión)
- Login con email/password en `index.html`
- **Sesión compartida entre pestañas** (`browserLocalPersistence`) en `dashboard.js`, `index.js` y `projector.html` — iniciar sesión una vez es válido en todas las pestañas/ventanas del navegador (dashboard, proyector, index) sin volver a pedir credenciales
- `index.html` **ya no redirige automáticamente** al dashboard si ya hay sesión — el botón "Acceso Docente" cambia a "Ir al Dashboard →" cuando corresponde, pero el contenido de juegos/cuestionarios de la página sigue siempre visible
- Margen de espera (1.5s) antes de redirigir a `index.html` cuando `onAuthStateChanged` reporta `!user`, para filtrar parpadeos momentáneos de sincronización entre pestañas y no expulsar sesiones válidas (`dashboard.js`, `projector.html`)
- Auth anónima para estudiantes en `student.html` ahora usa **`inMemoryPersistence`** (antes usaba la persistencia por defecto de Firebase) — evita que abrir el portal del estudiante sobrescriba la sesión compartida del profesor en otras pestañas
- Cierre de sesión automático por inactividad (30 min) vía `localStorage`, con aviso visible al volver al login (antes el aviso quedaba escrito dentro de un modal cerrado, invisible)
- Validación de email exacto al cargar dashboard (dos correos autorizados)
- XSS fix en `quizResults` (escaping en renderizado)

### Sincronización de datos (rediseñado esta sesión)
- **Reemplazado el caché en `localStorage` con TTL de 10 min por listeners en tiempo real de Firestore (`onSnapshot`)** para `tribes`, `students` y `attendance`
- Cualquier cambio (de esta pestaña, otra pestaña, u otro dispositivo) se refleja en milisegundos en todas las vistas abiertas, sin depender de refrescos manuales
- `loadAllData()`, `refreshCoreData()` y las funciones `cacheAdd*/cacheUpdate*/cacheDelete*` se conservaron con la misma firma por compatibilidad; internamente ahora son más simples o no-ops
- Esto también corrigió el bug de **asistencia duplicada falsa** entre pestañas (una pestaña podía sobrescribir en `localStorage` la copia de la otra)

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
- **Nuevo — desglose por curso en el modal de registro:** además del total del día, chips tipo "7°: 18/30" por cada curso con registros. El curso seleccionado en la barra superior siempre aparece resaltado (incluso en 0), y se pone en verde con ✓ cuando se completa todo el curso matriculado

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
- Filtros: tipo, origen, fecha desde/hasta, búsqueda por nombre, **y ahora también por curso** (nuevo — resuelve el curso de cada registro vía la tribu o el estudiante vinculado; útil cuando no se recuerda el nombre exacto de la tribu)

### Reparación de datos (nuevo esta sesión)
- **Botón "🔗 Reparar vínculos"** en el header del dashboard
- Detecta integrantes de tribu cuyo `studentId` está ausente o apunta a un estudiante que ya no existe (vínculo roto → sin botón de puntos individuales ni insignia de nivel)
- Busca, dentro del mismo curso de la tribu, un estudiante cuyo nombre coincida (ignora mayúsculas, tildes, espacios) y relinkea automáticamente solo si hay una única coincidencia
- Reporta en pantalla lo reparado y lo que quedó pendiente de revisión manual
- **Nota:** esta herramienta corrige el síntoma; no se identificó con certeza el punto exacto del código donde se pierde el `studentId` originalmente (ver Notas operativas)

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
- Auth anónima automática (ahora con `inMemoryPersistence`, ver arriba)

### Cuestionarios (rediseñado esta sesión)
- Los 4 cuestionarios (`autoevaluacion_etica`, `excelencia`, `generosidad`, `talentos`) ya validaban previamente que se respondieran todas las preguntas obligatorias antes de enviar (mensaje visible tipo modal) — confirmado, no era necesario corregirlo
- **Nuevo — redirección automática al finalizar:** tras enviar/guardar resultados con éxito, cuenta regresiva de 6s y redirección a `../index.html`. Se conserva un botón manual ("Volver al inicio" / "Volver al Menú Principal") para salir antes
- Rutas de retorno corregidas de `/` a `../index.html` (más explícito, no depende de la config de enrutamiento del hosting)

### Otros
- Carnés QR: generación en pantalla, selección individual, impresión agrupada por curso, exportación a PDF (jsPDF)
- Ranking: podio sin empates con 0 pts, posiciones estilo "1224", caja de búsqueda por nombre, recarga fresca al abrir
- Resultados de cuestionarios: filtros por tipo, curso, fecha, nombre
- Entrega de Syllabus: +10 pts, una sola vez, badge visual en lista de estudiantes
- Cierre automático de sesión (30 min inactividad), con aviso en login si expiró
- Selector de cámara USB para asistencia (preferencia guardada en localStorage)
- Doble confirmación al eliminar estudiante o tribu

---

## Sincronización de datos (localStorage → tiempo real)
- ~~Caché en localStorage con TTL~~ **reemplazado esta sesión** por `onSnapshot` (ver sección "Sincronización de datos" arriba)
- `dataCache` sigue existiendo como estructura en memoria (`tribes`, `students`, `attendance`), pero ahora se llena y mantiene actualizada vía listeners en tiempo real, no vía lecturas puntuales con TTL
- El ranking y la auditoría siguen leyendo derivado de `dataCache` (ya siempre fresco); la auditoría `autoRepairAttendance` sigue leyendo directo de Firestore

---

## Pendiente (lista priorizada)
| # | Tarea | Prioridad |
|---|---|---|
| 1 | Verificar ranking todos los cursos tras ejecutar reparación | Media |
| 2 | Correr "Completar fechas para desempate de ranking" una vez (backfill pointsUpdatedAt) | Media |
| 3 | Encontrar la causa raíz de por qué algunos integrantes de tribu pierden su `studentId` (mitigado con "Reparar vínculos", no resuelto de raíz) | Media |
| 4 | Confirmar en producción que el vaivén de sesión entre pestañas (dashboard/proyector/index) quedó resuelto tras alinear `browserLocalPersistence` en los tres archivos | Alta (pendiente de confirmación del usuario) |

## Última sesión — completado
- **Sesión multi-pestaña, de punta a punta:** persistencia compartida (`browserLocalPersistence`) en `dashboard.js`, `index.js` y `projector.html`; margen de espera ante parpadeos de sincronización; `index.html` ya no auto-redirige; auth anónima de `student.js` movida a `inMemoryPersistence` para no chocar con la sesión del profesor. Causa raíz final del vaivén dashboard↔proyector: `projector.html` no fijaba persistencia explícita y caía en el valor por defecto del SDK (`indexedDBLocalPersistence`), distinto al de las demás páginas.
- **Sincronización de datos:** caché `localStorage` + TTL de 10 min reemplazado por listeners `onSnapshot` en tiempo real para tribus/estudiantes/asistencia. Corrige de raíz el bug de asistencia duplicada falsa entre pestañas.
- **Asistencia:** desglose por curso en el modal de registro (chips "curso: X/Y", resaltado del curso activo, ✓ al completar).
- **Log de puntos:** nuevo filtro por curso, combinable con tipo/origen/búsqueda/fechas.
- **Reparación de datos:** nueva herramienta "Reparar vínculos" para restablecer automáticamente el `studentId` de integrantes de tribu con vínculo roto (por coincidencia de nombre + curso).
- **Cuestionarios:** redirección automática a `index.html` tras enviar resultados con éxito (los 4 cuestionarios), con cuenta regresiva visible y opción de salir antes manualmente.

## Sesiones anteriores — completado (histórico)
- Ranking: desempate justo por quién llegó primero al puntaje (`pointsUpdatedAt`) en vez de alfabético. Campo se guarda en `awardLevelPoints()` y `updateStudentPoints()` cada vez que cambian los puntos de nivel. Tooltip en la posición muestra la fecha exacta. Botón "Completar fechas para desempate de ranking" en Historial de Asistencia hace backfill desde `pointsLog` para estudiantes con puntos previos a este cambio.
- Deshacer entrega de Syllabus: badge "entregado" ahora es clicable (resta 10pts/10🪙 con confirmación). Confirmación agregada también antes de asignar por primera vez. Limitación conocida: bono de monedas por nivel no se revierte automáticamente en el undo.
- Auto-refresco extendido con patrón reutilizable `createAutoRefresh()` + `refreshCoreData()` a vista principal de tribus, Gestión de estudiantes, Log de puntos y Ranking. **Nota:** con la migración a `onSnapshot`, estos temporizadores ya son redundantes como mecanismo principal de actualización — se conservaron como red de seguridad silenciosa.
- ~~Sesión por pestaña (browserSessionPersistence)~~ **revertido esta sesión** a sesión compartida entre pestañas (ver arriba) — el aislamiento por pestaña impedía mostrar `index.html` con los juegos/cuestionarios mientras el profesor tenía sesión activa.

---

## Notas operativas importantes
- **Firestore Spark (gratuito):** límite 50,000 lecturas/día. Con `onSnapshot` el conteo de "lecturas" ahora incluye la carga inicial de cada listener más cada documento que cambie; vigilar cuotas si el uso crece bastante (bajo riesgo actual dado el volumen de una sola institución).
- **`student.html`** tiene **dos** bloques de código casi idénticos (dos versiones de `renderPortal`). Al editar, buscar ambas ocurrencias — confirmado y aplicado así en el fix de `inMemoryPersistence` de esta sesión.
- **Puntos de tribu vs asistencia:** la auditoría espera 1 punto por asistencia. Diferencias mayores indican puntos manuales (normales) o duplicados (bug).
- **`tribePointsAwarded: false`** = pendiente de asignar punto de tribu. `undefined` = ya procesado (no sumar de nuevo).
- El campo `studentId` en los miembros de tribu es crítico — perderlo deshabilita los botones de puntos. Se revisaron todas las funciones conocidas que tocan `members` (`addMember`, `deleteMember`, `openEditMemberModal`) y todas preservan `studentId` correctamente — la causa de fondo por la que 3 estudiantes perdieron el vínculo esta sesión **no quedó identificada**; se mitigó con la herramienta "Reparar vínculos" (ver Pendiente #3).
- El respaldo de Google Apps Script requiere el fix de `replace(/\\n/g, '\n')` en `getAccessToken()`.
- **Persistencia de Firebase Auth:** las tres páginas que comparten sesión de profesor (`dashboard.html`, `index.html`, `projector.html`) DEBEN fijar explícitamente `setPersistence(auth, browserLocalPersistence)`. Si una nueva página se agrega al proyecto y necesita la sesión del profesor, no basta con `getAuth(app)` — hay que replicar esa línea, o el SDK puede caer en `indexedDBLocalPersistence` por defecto y generar conflictos de sesión entre pestañas.
- **Persistencia de auth anónima (estudiante/proyector-sin-sesión):** cualquier flujo de `signInAnonymously` debe usar `inMemoryPersistence` explícitamente, para no interferir con la sesión compartida del profesor en el mismo navegador.

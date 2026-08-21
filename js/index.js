import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
    import { getAuth, setPersistence, browserLocalPersistence, signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";

    const app = initializeApp(window.firebaseConfig);
    const auth = getAuth(app);

    // Persistencia compartida entre pestañas: iniciar sesión una vez es válido
    // para todas las pestañas/ventanas del mismo navegador (dashboard, proyector,
    // este index, etc.). Ya no hace falta volver a ingresar usuario y contraseña
    // en cada pestaña nueva.
    await setPersistence(auth, browserLocalPersistence);

    const AUTHORIZED_EMAILS = ["rrnewball@gmail.com", "ronald.rojas@bethshalom.edu.co"];

    // Antes: si ya había sesión, esta página redirigía automáticamente a
    // dashboard.html, lo que hacía imposible mostrar el index (con los juegos
    // y cuestionarios de la parte inferior) mientras el profesor tenía sesión
    // iniciada. Ahora el index se muestra siempre; si ya hay sesión activa,
    // se reemplaza el formulario de login por un aviso con acceso directo al
    // dashboard, sin tocar el resto del contenido de la página.
    onAuthStateChanged(auth, (user) => {
        const loginError = document.getElementById("loginError");
        const loginForm = document.getElementById("loginEmail")?.closest("form") || null;

        if (user && AUTHORIZED_EMAILS.includes(user.email)) {
            localStorage.setItem("ethykos_lastActive", Date.now().toString());
            if (loginForm) loginForm.style.display = "none";
            if (loginError) {
                loginError.innerHTML = '✅ Ya tienes sesión iniciada como profesor. <a href="dashboard.html" style="color:#2563EB;font-weight:600;text-decoration:underline;">Ir al Dashboard →</a>';
                loginError.style.color = "#059669";
            }
        } else {
            // Sin sesión, o sesión no autorizada (ej. anónima de un estudiante
            // en otra pestaña): se muestra el formulario de login normalmente.
            if (loginForm) loginForm.style.display = "";
        }
    });

    // Aviso si venimos de un cierre de sesión automático por inactividad
    if (new URLSearchParams(window.location.search).get("expired") === "1") {
        const loginError = document.getElementById("loginError");
        if (loginError) {
            loginError.textContent = "Tu sesión se cerró por inactividad (30 min). Vuelve a iniciar sesión.";
            loginError.style.color = "#D97706";
        }
    }

    window.doLogin = async function() {
        const email = document.getElementById("loginEmail").value.trim();
        const password = document.getElementById("loginPassword").value;
        const loginError = document.getElementById("loginError");
        if (!email || !password) { loginError.textContent = "Ingresa correo y contraseña"; return; }
        loginError.textContent = "Iniciando sesión...";
        loginError.style.color = "#2563EB";
        try {
            await signInWithEmailAndPassword(auth, email, password);
            localStorage.setItem("ethykos_lastActive", Date.now().toString());
            window.location.href = "dashboard.html";
        } catch (error) {
            const msgs = { 'auth/user-not-found': 'Usuario no encontrado.', 'auth/wrong-password': 'Contraseña incorrecta.', 'auth/invalid-email': 'Correo inválido.', 'auth/api-key-not-valid': 'Error de API key.' };
            loginError.textContent = msgs[error.code] || "Error: " + error.message;
            loginError.style.color = "#EF4444";
        }
    };

    document.getElementById("doLoginBtn").onclick = window.doLogin;
    document.getElementById("loginPassword").addEventListener("keypress", function(e) { if (e.key === "Enter") window.doLogin(); });
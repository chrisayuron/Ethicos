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

    // El login vive dentro de un modal oculto (#loginModal) que solo se abre al
    // hacer clic en el botón "Acceso Docente" (#mostrarLoginBtn) — el resto de la
    // página (juegos, cuestionarios, etc.) siempre está visible sin importar la
    // sesión. Antes, esta página redirigía sola a dashboard.html apenas detectaba
    // sesión activa, lo que la volvía inútil para mostrarla a los estudiantes si
    // el profesor tenía sesión abierta en otra pestaña. Ahora nunca redirige sola:
    // en vez de eso, el botón "Acceso Docente" cambia de comportamiento según si
    // ya hay sesión.
    const mostrarLoginBtn = document.getElementById("mostrarLoginBtn");
    const originalLoginBtnHTML = mostrarLoginBtn ? mostrarLoginBtn.innerHTML : "";

    function openLoginModal() {
        const loginModal = document.getElementById("loginModal");
        const loginError = document.getElementById("loginError");
        const loginPassword = document.getElementById("loginPassword");
        const togglePasswordBtn = document.getElementById("togglePasswordBtn");
        if (loginModal) loginModal.style.display = "flex";
        if (loginError) { loginError.textContent = ""; loginError.style.color = ""; }
        if (loginPassword) { loginPassword.value = ""; loginPassword.setAttribute("type", "password"); }
        if (togglePasswordBtn) { const icon = togglePasswordBtn.querySelector("i"); if (icon) icon.className = "fas fa-eye"; }
    }

    function setLoggedInButton() {
        if (!mostrarLoginBtn) return;
        mostrarLoginBtn.innerHTML = '<i class="fas fa-arrow-right"></i> Ir al Dashboard';
        mostrarLoginBtn.onclick = function() { window.location.href = "dashboard.html"; };
    }
    function setLoggedOutButton() {
        if (!mostrarLoginBtn) return;
        mostrarLoginBtn.innerHTML = originalLoginBtnHTML;
        mostrarLoginBtn.onclick = openLoginModal;
    }

    onAuthStateChanged(auth, (user) => {
        if (user && AUTHORIZED_EMAILS.includes(user.email)) {
            localStorage.setItem("ethykos_lastActive", Date.now().toString());
            setLoggedInButton();
        } else {
            // Sin sesión, o sesión no autorizada (ej. anónima de un estudiante
            // abierta en otra pestaña): el botón abre el login normalmente.
            setLoggedOutButton();
        }
    });

    // Aviso si venimos de un cierre de sesión automático por inactividad.
    // Se abre el modal de login directamente para que el aviso sea visible
    // (antes el mensaje quedaba escrito dentro del modal, pero como este
    // permanece cerrado hasta que el profesor hace clic en "Acceso Docente",
    // nunca llegaba a verse).
    if (new URLSearchParams(window.location.search).get("expired") === "1") {
        openLoginModal();
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
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
    import { getAuth, signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";

    const app = initializeApp(window.firebaseConfig);
    const auth = getAuth(app);

    onAuthStateChanged(auth, (user) => { if (user) { localStorage.setItem("ethykos_lastActive", Date.now().toString()); window.location.href = "dashboard.html"; } });

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
document.addEventListener('DOMContentLoaded', () => {
    // 1. Crée le widget flottant de sélection de thèmes
    const selector = document.createElement('div');
    selector.className = 'crt-theme-selector';
    selector.innerHTML = `
        <span class="theme-title">CRT COLOR</span>
        <div class="theme-buttons">
            <button class="theme-dot dot-green" data-theme="green" title="Vert Phosphore"></button>
            <button class="theme-dot dot-amber" data-theme="amber" title="Ambre Rétro"></button>
            <button class="theme-dot dot-cyan" data-theme="cyan" title="Cyan Cyberpunk"></button>
            <button class="theme-dot dot-red" data-theme="red" title="Mr. Robot Rouge"></button>
        </div>
    `;
    
    document.body.appendChild(selector);
    
    // 2. Charge le thème sauvegardé
    const savedTheme = localStorage.getItem('crt-theme') || 'green';
    applyTheme(savedTheme);
    
    // 3. Écouteur d'évènement pour changer de thème
    selector.addEventListener('click', (e) => {
        if (e.target.classList.contains('theme-dot')) {
            const theme = e.target.getAttribute('data-theme');
            applyTheme(theme);
            localStorage.setItem('crt-theme', theme);
        }
    });
    
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        
        // Optionnel : Mettre à jour l'état visuel actif des boutons
        const dots = selector.querySelectorAll('.theme-dot');
        dots.forEach(dot => {
            if (dot.getAttribute('data-theme') === theme) {
                dot.classList.add('active');
            } else {
                dot.classList.remove('active');
            }
        });
    }
});

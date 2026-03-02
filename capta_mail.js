document.addEventListener('DOMContentLoaded', () => {
    const btnMail = document.getElementById('btn-mail-secure');

    btnMail.addEventListener('click', function(event) {
        event.preventDefault(); // Empêche le comportement par défaut

        // La boîte de dialogue native qui bloque l'exécution
        const reponse = prompt("[ACCÈS RESTREINT] Prouvez votre légitimité.\nQuel est le port réseau par défaut pour une connexion SSH ?");

        // Vérification de la réponse (22)
        if (reponse === "22") {
            alert("Accès autorisé. Initialisation de la messagerie...");
            
            // Reconstitution de l'email pour le cacher des bots
            const nom = "vincentklein57950"; // À remplacer par la première partie de votre mail
            const domaine = "outlook.fr"; // À remplacer par la fin de votre mail
            
            // Ouvre le client mail de l'utilisateur
            window.location.href = "mailto:" + nom + "@" + domaine;
        } else if (reponse !== null) {
            // Si l'utilisateur s'est trompé (et n'a pas cliqué sur Annuler)
            alert("Accès refusé. Tentative d'intrusion signalée.");
        }
    });
});
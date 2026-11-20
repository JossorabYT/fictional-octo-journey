# Phrase Phone

Jeu d'histoires à plusieurs : chaque personne écrit un début, puis les récits tournent entre joueurs qui ajoutent leur phrase en secret. La partie se joue à distance avec un code de salon; toutes les histoires se révèlent à la fin.

## État du jeu

Le backend Supabase dédié est déjà créé et configuré dans `config.js`. Le schéma actualisé est aussi disponible dans `schema.sql` pour référence. Les salons créés avec l'ancien fonctionnement ne sont pas compatibles avec le nouveau mode; crée un nouveau salon pour chaque nouvelle partie.

## Publier sur GitHub Pages

1. Ajoute les fichiers de ce dossier à la racine du dépôt GitHub.
2. Dans le dépôt, ouvre **Settings → Pages**.
3. Dans **Build and deployment**, choisis **Deploy from a branch**, puis la branche `main` et le dossier `/ (root)`.
4. Enregistre. GitHub affichera l'adresse du site sur cette page après la publication.

La clé `sb_publishable_...` dans `config.js` est une clé publique prévue pour le navigateur. Ne publie jamais de clé `secret` ou `service_role`.

## Jouer

Ouvre le site, crée un salon et partage le code ou le lien d'invitation. Chaque joueur rejoint avec son prénom. L'hôte lance quand tout le monde est là. Tout le monde écrit alors une ouverture en même temps. Ensuite, à chaque manche, tous les joueurs ajoutent une phrase à une histoire qu'ils n'ont pas commencée. Les histoires restent cachées jusqu'à la révélation finale.

Les salons acceptent de 2 à 12 joueurs. Chaque histoire est continuée par chaque autre joueur. Les salons et l'avancement des manches se rafraîchissent automatiquement toutes les 2,5 secondes. À la fin, les histoires se découvrent une par une dans un diaporama; utilise les flèches du clavier ou les boutons pour naviguer. Le narrateur utilise la lecture vocale française intégrée au navigateur : il peut lire une histoire ou enchaîner toute la présentation.

Le thème jour/nuit se change avec le bouton en haut à droite et reste mémorisé sur l'appareil. Le logo est le fichier `logo.svg`.

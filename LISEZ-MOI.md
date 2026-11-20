# Phrase Phone

Jeu d'histoires à plusieurs : le premier joueur écrit l'ouverture, puis chacun ajoute une phrase en ne voyant que la précédente. La partie se joue à distance avec un code de salon; l'histoire complète se révèle à la fin.

## État du jeu

Le backend Supabase dédié est déjà créé et configuré dans `config.js`. Le schéma de la base est aussi disponible dans `schema.sql` pour référence. Ne le relance pas dans un autre projet sans vérifier au préalable qu'il est vide.

## Publier sur GitHub Pages

1. Ajoute les fichiers de ce dossier à la racine du dépôt GitHub.
2. Dans le dépôt, ouvre **Settings → Pages**.
3. Dans **Build and deployment**, choisis **Deploy from a branch**, puis la branche `main` et le dossier `/ (root)`.
4. Enregistre. GitHub affichera l'adresse du site sur cette page après la publication.

La clé `sb_publishable_...` dans `config.js` est une clé publique prévue pour le navigateur. Ne publie jamais de clé `secret` ou `service_role`.

## Jouer

Ouvre le site, crée un salon et partage le code ou le lien d'invitation. Chaque joueur rejoint avec son prénom. L'hôte lance quand tout le monde est là. Le joueur dont c'est le tour écrit une phrase; les autres attendent. À la fin, tout le monde découvre l'histoire complète.

Les salons acceptent de 2 à 12 joueurs. Les tours et la liste des joueurs se rafraîchissent automatiquement toutes les 2,5 secondes.

Le thème jour/nuit se change avec le bouton en haut à droite et reste mémorisé sur l'appareil. Le logo est le fichier `logo.svg`.

# Mergify Fleet Scanner — aucun accès en écriture

Le scanner est conçu pour **n'importe quel dépôt GitHub auquel le compte local a accès**, qu'il soit ou non déjà dans le registre Memo Labs. La seule dépendance en dehors de Node.js est `gh` authentifié (lecture GitHub). Aucun jeton n'est écrit en sortie.

Sur le Mac équipé de GitHub CLI :

```bash
# 1. Lecture API de n'importe quel dépôt, sans changement de configuration
node scripts/mergify-scan.mjs memolabs-dev/drop > /tmp/drop-mergify-snapshot.json

# 2. Diagnostic bloquant et vérification des prérequis
node scripts/mergify-fleet.mjs audit /tmp/drop-mergify-snapshot.json

# 3. Candidat YAML, avec une date UTC future à recalculer au moment de la bascule
node scripts/mergify-fleet.mjs candidate /tmp/drop-mergify-snapshot.json memolabs-dev/drop 2099-01-01T00:00:00Z > /tmp/drop.mergify.yml
```

Le scanner récupère (API GitHub en **GET seulement**) la branche, le statut du dépôt, les workflows Actions, les derniers check-runs de PR, les règles de branche et la présence éventuelle de Mergify. Les noms de CI fournis sont des **suggestions observées**, pas une attestation de couverture complète. Un échec API, un accès incomplet, un ancien exécuteur non identifié ou un dépôt non vérifiable produit un diagnostic conservateur.

Le fichier `candidate` est du texte généré. Il ne touche pas au dépôt et ne vaut **jamais** autorisation d'activation. Avant toute adoption, il faut vérifier la pertinence des CI, les exceptions sensibles, la présence de Mergify, isoler l'ancien moteur et réaliser les canaris positif/négatif, selon `docs/MERGIFY_FLEET_ADOPTION.md`.

La date `2099-01-01` des exemples est **délibérément non opérationnelle**. Elle bloque toute PR avant cette date. Il faut fixer une date UTC **future par rapport à l'instant réel de la mise en service** et revérifier les PR encore ouvertes afin qu'aucune PR existante ne soit activée par accident.

Le contrôle `auditRecord` retourne systématiquement `activation_authorized: false`. Seules les procédures administratives autorisées et l'évidence Mergify propre à chaque dépôt permettent de mettre une politique en production.

# Iskra

Intégration non officielle, sans lien avec Iskra. Elle lit les compteurs
d'énergie Iskra reliés à une passerelle **Iskra Smart Gateway (SG)**, par
l'API REST locale de la passerelle : pas de cloud, pas de compte, rien
d'envoyé à la passerelle que des requêtes de lecture (GET), une tournée toutes
les 30 secondes au plus.

**Jamais testé avec une vraie passerelle Iskra** : elle a été écrite à partir
de la bibliothèque Python du fabricant (pyiskra, celle qu'utilise Home
Assistant). Vos retours sont les bienvenus.

## Compteurs pris en charge

Les compteurs que la bibliothèque lit derrière une Smart Gateway : IE38,
IE35, IE14 (IMPACT), WM3M4, WM3, WM1, MC, iMC, MT, iMT (Measuring Centres).
Les autres modèles listés par la passerelle sont nommés dans l'état et ne
sont pas lus. Au plus 16 compteurs sont lus (les autres sont comptés dans
l'état). Un compteur joint directement en Modbus TCP, sans la
passerelle, n'est pas encore pris en charge.

L'index de consommation vient des registres d'énergie **non remettables à
zéro** : les IE38, IE35, IE14, WM3 et WM3M4 en ont. Pour les MC, iMC, MT, iMT
et WM1, pyiskra ne connaît que des registres remettables à zéro : ces
compteurs ne donnent **pas d'index de consommation** (puissance et phases
seulement), et l'état le dit.

## Ce que vous obtenez

Un appareil par compteur, nommé d'après son modèle et son numéro de série
(`Iskra IE38MD 41000001`), avec les valeurs que le compteur donne :

| Fonction                             | Nature                                      |
| ------------------------------------ | ------------------------------------------- |
| Puissance active (voir plus bas)     | capteur d'énergie, W                        |
| Index de consommation                | index d'énergie, kWh                        |
| Index d'injection (kWh)              | simple capteur                              |
| Tension L1, L2, L3                   | capteur d'énergie, V, sans historique       |
| Courant L1, L2, L3                   | capteur d'énergie, A, sans historique       |
| Puissance L1, L2, L3 (W)             | simple capteur, sans historique             |
| Facteur de puissance, fréquence (Hz) | simple capteur, sans historique             |
| Température du compteur              | température d'appareil, °C, sans historique |

- L'**index de consommation** alimente le suivi énergétique de Gladys :
  Gladys en déduit la consommation et son coût. Il vient du premier registre
  non remettable à zéro d'énergie active importée par le compteur (choisi à
  la première lecture du compteur, puis gardé avec sa position et son nom).
  Si un autre registre prend sa place, l'index attend (note dans l'état).
  Supprimer puis recréer l'appareil choisit à nouveau le registre. Il est publié au plus une fois
  par minute et vérifié d'abord : jamais 0 ; toute baisse, même de 1 Wh, ou
  un saut plus grand que ce que le compteur a pu mesurer (la « puissance
  plausible la plus haute » de la configuration, 100 kW par défaut, sur le
  temps écoulé depuis la dernière valeur) est **retenu** (la dernière valeur
  acceptée est renvoyée) et affiché dans l'état de l'intégration. S'il est
  juste (un nouveau compteur, une longue coupure), cliquez deux fois sur
  **Accepter l'index retenu** (voir Boutons). Enregistrer la configuration ne
  l'accepte jamais.
- L'**injection** (le premier registre non remettable à zéro d'énergie active
  exportée) n'entre jamais dans le suivi énergétique (elle serait facturée
  comme consommation) : simple capteur.
- Les registres remettables à zéro (« resettable ») ne sont pas lus : un
  registre qu'on peut remettre à zéro n'est jamais un index.
- La **puissance active** est le total du compteur. Son signe quand le site
  injecte est à confirmer sur un vrai compteur (sans doute négatif).
- Les valeurs instantanées sont envoyées à chaque lecture, seulement quand
  elles changent (et toutes les 10 minutes sinon). L'intervalle grandit avec
  beaucoup de compteurs (8 secondes par compteur, soit 80 secondes avec 10
  compteurs), pour que Gladys ne reçoive jamais plus qu'il n'accepte.
- Quand toutes les valeurs instantanées d'un compteur (tensions au 0,1 V,
  fréquence au 0,01 Hz, courants…) restent exactement les mêmes pendant 15
  minutes, la passerelle sert sans doute une vieille copie : elles ne sont
  plus envoyées et l'état le dit, y compris après un redémarrage. L'index
  n'est pas concerné.

## Installation

1. Trouvez l'adresse IP de la Smart Gateway (dans votre box, ou les outils
   Iskra) et donnez-lui de préférence une adresse fixe dans votre box.
2. Dans Gladys, ouvrez l'intégration, saisissez cette adresse. Si
   l'interface web de la passerelle demande des identifiants, saisissez aussi
   son nom d'utilisateur et son mot de passe ; sinon laissez-les vides.
   Enregistrez.
3. Dans l'onglet **Découverte**, créez l'appareil de chaque compteur.

## Les identifiants

Le mot de passe est gardé par Gladys dans sa base, jamais réaffiché, jamais
écrit dans les journaux. Il n'est envoyé qu'à l'adresse de la passerelle,
comme la passerelle le demande : dans un cookie, en HTTP simple sur votre
réseau (la passerelle ne propose rien d'autre). Si la passerelle refuse les
identifiants, les lectures s'arrêtent et l'état le dit : corrigez le nom
d'utilisateur ou le mot de passe et enregistrez, ou cliquez sur **Tester la
connexion** pour réessayer une fois. L'intégration ne réessaie jamais
d'elle-même des identifiants refusés, même après un redémarrage. Pour
reconnaître « les mêmes identifiants » après un redémarrage, elle ne garde
dans `/data` que 8 bits d'une empreinte salée du mot de passe refusé (jamais
le mot de passe lui-même).

## Boutons

- **Tester la connexion** : lit la passerelle une fois quand une lecture est
  due (jamais plus d'une toutes les 30 secondes), sinon donne la dernière
  lecture : la passerelle, ses compteurs, leur puissance et leur index. Après
  des identifiants refusés, il réessaie une fois ; seul un succès lève le
  refus.
- **Accepter l'index retenu**, en deux clics. Le premier clic liste les
  index retenus, par compteur, et ne prend rien. Le second clic, de quelques
  secondes à 5 minutes plus tard, prend exactement ce que le premier a listé,
  et pour chaque compteur seulement si sa valeur retenue n'a pas changé
  depuis (au-delà de ce que le compteur a pu mesurer entre-temps) ; un
  compteur retenu après le premier clic n'est jamais pris. Un saut est compté
  d'un coup comme consommation ; une baisse ne facture rien.

## En cas de problème

- **Injoignable ou réponse inattendue** : nouvel essai après 30 secondes,
  puis doublé jusqu'à 10 minutes.
- **La passerelle demande d'attendre (429) ou échoue (5xx)** : lectures en
  pause de 1 minute à 6 heures, y compris après un redémarrage.
- **Un compteur ne peut pas être lu** (sa page refusée, en erreur ou sans
  réponse) : les autres continuent, et l'état le nomme. Une tournée ne dure
  jamais plus de 60 secondes : les compteurs restants sont lus la fois
  suivante.
- **La liste des compteurs change pendant une lecture** : le compteur dont
  le port a changé ne reçoit rien de cette lecture. Chaque compteur est
  repéré par son numéro de série : ses valeurs ne vont jamais à l'appareil
  d'un autre compteur.
- **Le même numéro de série sur deux ports** (un compteur vu par deux
  interfaces, ou deux compteurs au numéro par défaut) : ces ports ne sont ni
  lus ni proposés en Découverte ; l'état les nomme.
- **Le registre de l'index a changé** (un autre registre à sa place, après
  une reconfiguration des registres) : l'index attend, l'état le dit ;
  supprimez puis recréez l'appareil pour choisir à nouveau le registre.

## Vie privée

Tout reste sur votre réseau. L'intégration n'envoie que des requêtes GET à
l'adresse saisie, avec les identifiants quand vous en avez donné.

// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They never
// quote a free text of the gateway (description, location): only our own
// words, error codes and the values we checked (serials and models passed the
// patterns of src/iskra/model.js). Never the login.
// -----------------------------------------------------------------------------

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const hours = (ms) => Math.max(1, Math.round(ms / 3_600_000));
export const delay = (ms) => {
  if (ms >= 2 * 3_600_000) return { en: `${hours(ms)} h`, fr: `${hours(ms)} h` };
  if (ms >= 60_000) return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
  return { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
};

/** Our words for an error code of src/iskra/client.js and src/app.js. */
const REASON = {
  timeout: { en: 'no answer', fr: 'pas de réponse' },
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  http: { en: 'HTTP error', fr: 'erreur HTTP' },
  redirect: {
    en: 'redirect refused (is it the gateway?)',
    fr: 'redirection refusée (est-ce bien la passerelle ?)',
  },
  not_found: {
    en: 'no REST API at this address (is it an Iskra Smart Gateway?)',
    fr: 'pas d’API REST à cette adresse (est-ce bien une passerelle Iskra Smart Gateway ?)',
  },
  server: { en: 'error of the gateway', fr: 'erreur de la passerelle' },
  rate_limited: { en: 'too many requests', fr: 'trop de requêtes' },
  refused: { en: 'login refused', fr: 'identifiants refusés' },
  list_refused: {
    en: 'the list of meters is refused to this login',
    fr: 'la liste des compteurs est refusée à ces identifiants',
  },
  too_large: { en: 'answer too large', fr: 'réponse trop grande' },
  not_json: { en: 'answer that is not data', fr: 'réponse qui n’est pas une donnée' },
  unknown_answer: {
    en: 'not an answer of an Iskra Smart Gateway',
    fr: 'ce n’est pas une réponse d’une passerelle Iskra Smart Gateway',
  },
};

export function reason(err) {
  const text = REASON[err?.code] ?? { en: 'unexpected error', fr: 'erreur inattendue' };
  const status =
    (err?.code === 'http' || err?.code === 'server') && Number.isInteger(err.status)
      ? ` ${err.status}`
      : '';
  return { en: `${text.en}${status}`, fr: `${text.fr}${status}` };
}

const kwh = (value) => Math.round(value * 1000) / 1000;
const list = (items) => items.join(', ');

/** `ago` ms ago, or undefined for a read made by this click. */
const when = (ago) =>
  ago === undefined
    ? { en: 'Read now', fr: 'Lu à l’instant' }
    : { en: `Last read ${delay(ago).en} ago`, fr: `Dernière lecture il y a ${delay(ago).fr}` };

const join = (lang, first, notes) => [first[lang], ...notes.map((n) => n[lang])].join(' ');
const withNotes = (first, notes) => ({
  en: join('en', first, notes),
  fr: join('fr', first, notes),
});

/** The next read, or nothing when no read is planned (a refused login). */
const nextRead = (next) =>
  next === undefined
    ? { en: '', fr: '' }
    : { en: ` Next read in ${delay(next).en}.`, fr: ` Prochaine lecture dans ${delay(next).fr}.` };

export const T = {
  incomplete: {
    en: 'Enter the address of your Iskra Smart Gateway (its IP address on your network, e.g. 192.168.1.80).',
    fr: 'Saisissez l’adresse de votre passerelle Iskra Smart Gateway (son adresse IP sur votre réseau, ex. 192.168.1.80).',
  },
  badAddress: {
    en: 'The gateway address is not valid: enter an IP address or a host name, with an optional port (e.g. 192.168.1.80).',
    fr: 'L’adresse de la passerelle n’est pas valide : saisissez une adresse IP ou un nom d’hôte, avec un port éventuel (ex. 192.168.1.80).',
  },
  badLogin: {
    en: 'The login is incomplete or not valid: fill both the user name (without ":") and the password, or leave both empty.',
    fr: 'Les identifiants sont incomplets ou invalides : remplissez le nom d’utilisateur (sans « : ») et le mot de passe, ou laissez les deux vides.',
  },
  /** The gateway refused the login on its main page: no read until it changes. */
  refused: (address, hasLogin, notes = []) =>
    withNotes(
      hasLogin
        ? {
            en: `The Iskra gateway at ${address} refuses this login: reads stopped. Correct the user name or the password and save, or click "Test the connection" to try once more.`,
            fr: `La passerelle Iskra à l’adresse ${address} refuse ces identifiants : lectures arrêtées. Corrigez le nom d’utilisateur ou le mot de passe et enregistrez, ou cliquez sur « Tester la connexion » pour réessayer une fois.`,
          }
        : {
            en: `The Iskra gateway at ${address} asks for a login: reads stopped. Enter the user name and password of its web interface and save.`,
            fr: `La passerelle Iskra à l’adresse ${address} demande des identifiants : lectures arrêtées. Saisissez le nom d’utilisateur et le mot de passe de son interface web et enregistrez.`,
          },
      notes,
    ),
  /** `notes`: { en, fr } texts added after the failure (an index held back). */
  unreachable: (address, err, wait, notes = []) =>
    withNotes(
      {
        en: `The Iskra gateway at ${address} could not be read (${reason(err).en}): new try in ${delay(wait).en}.`,
        fr: `La passerelle Iskra à l’adresse ${address} n’a pas pu être lue (${reason(err).fr}) : nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  /** HTTP 429 or 5xx: a pause, kept across restarts. */
  paused: (address, err, wait, notes = []) =>
    withNotes(
      {
        en: `The Iskra gateway at ${address} asks to wait (${reason(err).en}): reads paused, new try in ${delay(wait).en}.`,
        fr: `La passerelle Iskra à l’adresse ${address} demande d’attendre (${reason(err).fr}) : lectures en pause, nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  noMeters: (gateway, notes = []) =>
    withNotes(
      {
        en: `Connected to the Iskra gateway ${gateway.model} ${gateway.serial}, but it lists no supported meter.`,
        fr: `Connecté à la passerelle Iskra ${gateway.model} ${gateway.serial}, mais elle ne liste aucun compteur pris en charge.`,
      },
      notes,
    ),
  waiting: (address, notes = []) =>
    withNotes(
      {
        en: `Waiting for the first answer of the Iskra gateway at ${address}.`,
        fr: `En attente de la première réponse de la passerelle Iskra à l’adresse ${address}.`,
      },
      notes,
    ),
  /** `notes`: { en, fr } texts added after the connection message. */
  ok: (address, gateway, count, notes = []) =>
    withNotes(
      {
        en: `Connected to the Iskra gateway ${gateway.model} ${gateway.serial} (${address}): ${count} meter(s) read.`,
        fr: `Connecté à la passerelle Iskra ${gateway.model} ${gateway.serial} (${address}) : ${count} compteur(s) lu(s).`,
      },
      notes,
    ),
  notes: {
    noDevice: (serials) => ({
      en: `Create the device of meter(s) ${list(serials)} from the "Discover" tab to receive their values.`,
      fr: `Créez l’appareil du ou des compteurs ${list(serials)} depuis l’onglet « Découverte » pour recevoir leurs valeurs.`,
    }),
    otherGateway: (serial) => ({
      en: `Another gateway answers at this address (${serial}): each meter keeps its own device, by its serial number.`,
      fr: `Une autre passerelle répond à cette adresse (${serial}) : chaque compteur garde son propre appareil, par son numéro de série.`,
    }),
    unsupported: (models) => ({
      en: `Meter model(s) not supported, not read: ${list(models)}.`,
      fr: `Modèle(s) de compteur non pris en charge, non lu(s) : ${list(models)}.`,
    }),
    unreadablePorts: (count) => ({
      en: `${count} port(s) of the gateway give no readable model or serial number: not read.`,
      fr: `${count} port(s) de la passerelle ne donnent pas de modèle ni de numéro de série lisible : non lu(s).`,
    }),
    unread: (items) => ({
      en: `Not read this time: ${list(items.map((i) => `${i.serial} (${reason(i).en})`))}.`,
      fr: `Non lu(s) cette fois : ${list(items.map((i) => `${i.serial} (${reason(i).fr})`))}.`,
    }),
    swapped: (serials) => ({
      en: `The list of meters changed during the read: nothing published for ${list(serials)} this time.`,
      fr: `La liste des compteurs a changé pendant la lecture : rien publié pour ${list(serials)} cette fois.`,
    }),
    slotChanged: (serials) => ({
      en: `The energy counter used for the index of ${list(serials)} is no longer an active import (or export) counter: its index waits. If the counters were set up again on the meter, delete and create the device again.`,
      fr: `Le compteur d’énergie utilisé pour l’index de ${list(serials)} n’est plus un compteur actif d’import (ou d’export) : son index attend. Si les compteurs ont été reconfigurés sur le compteur, supprimez puis recréez l’appareil.`,
    }),
    held: (serial, { direction, from, to }) => {
      if (direction === 'down') {
        return {
          en: `The consumption index of meter ${serial} dropped from ${kwh(from)} to ${kwh(to)} kWh: held back, the last accepted value is sent again. If the meter was really replaced or reset, click "Accept the held index" in the configuration of the integration: nothing is billed for the drop, the consumption goes on from there. Saving the configuration accepts nothing.`,
          fr: `L’index de consommation du compteur ${serial} a baissé de ${kwh(from)} à ${kwh(to)} kWh : retenu, la dernière valeur acceptée est renvoyée. Si le compteur a vraiment été remplacé ou remis à zéro, cliquez sur « Accepter l’index retenu » dans la configuration de l’intégration : rien n’est facturé pour la baisse, la consommation repart de là. Enregistrer la configuration n’accepte rien.`,
        };
      }
      const diff = kwh(to - from);
      return {
        en: `The consumption index of meter ${serial} jumped from ${kwh(from)} to ${kwh(to)} kWh: held back, not sent to the energy monitoring. If you click "Accept the held index" in the configuration of the integration, ${diff} kWh will be counted at once as consumption; accept only if this energy was really consumed. Saving the configuration accepts nothing.`,
        fr: `L’index de consommation du compteur ${serial} a sauté de ${kwh(from)} à ${kwh(to)} kWh : retenu, non envoyé au suivi énergétique. Si vous cliquez sur « Accepter l’index retenu » dans la configuration de l’intégration, ${diff} kWh seront comptés d’un coup comme consommation ; n’acceptez que si cette énergie a vraiment été consommée. Enregistrer la configuration n’accepte rien.`,
      };
    },
  },
  accept: {
    nothing: {
      en: 'No consumption index is held back: nothing to accept.',
      fr: 'Aucun index de consommation n’est retenu : rien à accepter.',
    },
    /** Each `{ serial, direction, from, to }` accepted. */
    done: (accepted) => {
      const en = accepted.map(({ serial, direction, from, to }) =>
        direction === 'down'
          ? `meter ${serial}: the index goes from ${kwh(from)} down to ${kwh(to)} kWh, 0 kWh counted for the drop`
          : `meter ${serial}: the index ${kwh(to)} kWh, ${kwh(to - from)} kWh (plus what is used meanwhile) counted at once as consumption`,
      );
      const fr = accepted.map(({ serial, direction, from, to }) =>
        direction === 'down'
          ? `compteur ${serial} : l’index passe de ${kwh(from)} à ${kwh(to)} kWh, 0 kWh compté pour la baisse`
          : `compteur ${serial} : l’index ${kwh(to)} kWh, ${kwh(to - from)} kWh (plus ce qui est consommé d’ici là) comptés d’un coup comme consommation`,
      );
      return {
        en: `Accepted at the next read: ${en.join('; ')}. A different value stays held.`,
        fr: `Accepté à la prochaine lecture : ${fr.join(' ; ')}. Une autre valeur reste retenue.`,
      };
    },
  },
  test: {
    /** The outcome of a read, `ago` ms ago (undefined: made by this click), the next in `next` ms. */
    reading: (gateway, meters, count, ago, next) => {
      const one = (m) => ({
        power: m.power === undefined ? '?' : `${Math.round(m.power)} W`,
        index: m.index === undefined ? '?' : `${kwh(m.index)} kWh`,
      });
      const en = meters.map((m) => `${m.model} ${m.serial} ${one(m).power}, index ${one(m).index}`);
      const fr = meters.map((m) => `${m.model} ${m.serial} ${one(m).power}, index ${one(m).index}`);
      return {
        en: `${when(ago).en}: gateway ${gateway.model} ${gateway.serial}, ${count} meter(s)${en.length ? `: ${en.join('; ')}` : ''}.${nextRead(next).en}`,
        fr: `${when(ago).fr} : passerelle ${gateway.model} ${gateway.serial}, ${count} compteur(s)${fr.length ? ` : ${fr.join(' ; ')}` : ''}.${nextRead(next).fr}`,
      };
    },
    failed: (address, err, ago, next) => ({
      en: `${when(ago).en}: the gateway at ${address} could not be read (${reason(err).en}).${nextRead(next).en}`,
      fr: `${when(ago).fr} : la passerelle à l’adresse ${address} n’a pas pu être lue (${reason(err).fr}).${nextRead(next).fr}`,
    }),
    notYet: (next, interval) => ({
      en: `No read yet with this configuration: the first one comes in ${delay(next).en} (never more than one every ${delay(interval).en}).`,
      fr: `Pas encore de lecture avec cette configuration : la première vient dans ${delay(next).fr} (jamais plus d’une toutes les ${delay(interval).fr}).`,
    }),
    slow: {
      en: 'The gateway is slow to answer: look at the integration status in a minute.',
      fr: 'La passerelle tarde à répondre : regardez l’état de l’intégration dans une minute.',
    },
  },
};

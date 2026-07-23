/**
 * Seeding di una demo credibile: il progetto "Honeycomb Studios", uno studio
 * che sta lanciando un'app mobile chiamata Nectar.
 *
 * Popola un workspace ricco — squadra di persone, agenti tematici assegnati
 * ai canali giusti, e conversazioni realistiche già in corso — così aprendo
 * Hive si vede subito cosa sa fare lo strumento, invece di una schermata
 * vuota.
 *
 * Idempotente: se il workspace demo esiste già, lo ricrea da zero.
 *
 *   npx tsx src/scripts/seed-demo.ts
 */
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db, schema, closeDb } from '../db/index.js';
import { hashPassword, encryptSecret, decryptSecret, secretHint } from '../lib/crypto.js';
import { colorFor, defaultToolIds } from '@hive/shared';

const OWNER_EMAIL = 'andrea@studey.com';
const WS_SLUG = 'honeycomb-studios';

/* ------------------------------------------------------------------ persone */

interface DemoMember {
  email: string;
  name: string;
  handle: string;
  emoji: string;
  role: 'admin' | 'member';
}

const MEMBERS: DemoMember[] = [
  { email: 'maya@honeycomb.studio', name: 'Maya Chen', handle: 'maya', emoji: '🎨', role: 'admin' },
  { email: 'jordan@honeycomb.studio', name: 'Jordan Brooks', handle: 'jordan', emoji: '🧭', role: 'admin' },
  { email: 'camille@honeycomb.studio', name: 'Camille Dubois', handle: 'camille', emoji: '📣', role: 'member' },
  { email: 'priya@honeycomb.studio', name: 'Priya Shah', handle: 'priya', emoji: '⚙️', role: 'member' },
];

/* ------------------------------------------------------------------- agenti */

interface DemoAgent {
  handle: string;
  name: string;
  emoji: string;
  color: string;
  kind: 'assistant' | 'developer';
  model: string;
  purpose: string;
  description: string;
  tools: string[];
  channels: string[]; // nomi canale
  autoRespond?: boolean;
}

const AGENTS: DemoAgent[] = [
  {
    handle: 'fizz',
    name: 'Fizz',
    emoji: '🐝',
    color: '#C8922F',
    kind: 'assistant',
    model: 'google/gemini-3.6-flash',
    purpose:
      'Assistente di prodotto dello studio. Aiuta con brainstorming, sintetizza discussioni, ' +
      'trasforma idee sparse in piani concreti e passa il lavoro all\'agente giusto quando serve.',
    description: 'Brainstorming, sintesi e piani',
    tools: ['web.search', 'hive.search_messages', 'hive.read_channel', 'hive.memory', 'hive.handoff'],
    channels: ['generale', 'design', 'flight-path', 'marketing'],
  },
  {
    handle: 'honey',
    name: 'Honey',
    emoji: '🍯',
    color: '#B8873B',
    kind: 'developer',
    model: 'anthropic/claude-opus-4.8',
    purpose:
      'Agente sviluppatore. Lavora sul codice dell\'app Nectar: legge il repo, implementa modifiche, ' +
      'esegue build e test. Ogni push o deploy passa da una conferma umana in chat.',
    description: 'Codice, build, fix, PR',
    tools: ['code.read', 'code.write', 'code.shell', 'code.subagents', 'code.push', 'hive.memory'],
    channels: ['flight-path', 'mobile'],
  },
  {
    handle: 'atlas',
    name: 'Atlas',
    emoji: '🧭',
    color: '#4E7C6B',
    kind: 'assistant',
    model: 'anthropic/claude-sonnet-5',
    purpose:
      'Analista di ricerca. Cerca sul web, confronta concorrenti, sintetizza studi e report, ' +
      'e prepara sommari con le fonti per aiutare le decisioni di prodotto e marketing.',
    description: 'Ricerca, analisi, benchmark',
    tools: ['web.search', 'web.fetch', 'hive.search_messages', 'hive.memory'],
    channels: ['ricerca', 'marketing'],
  },
  {
    handle: 'quill',
    name: 'Quill',
    emoji: '✍️',
    color: '#A65160',
    kind: 'assistant',
    model: 'openai/gpt-5.6-luna',
    purpose:
      'Copywriter. Scrive testi per il lancio: annunci, post social, testo dei bottoni, email. ' +
      'Tono giovane e diretto, adatto agli studenti. Propone sempre più varianti.',
    description: 'Copy, annunci, social',
    tools: ['web.search', 'hive.search_messages', 'hive.read_channel', 'hive.memory'],
    channels: ['marketing'],
  },
  {
    handle: 'pixel',
    name: 'Pixel',
    emoji: '🎨',
    color: '#7A5C8E',
    kind: 'assistant',
    model: 'anthropic/claude-sonnet-5',
    purpose:
      'Critico di design. Rivede schermate e flussi, segnala problemi di coerenza, gerarchia, ' +
      'accessibilità e microcopy. Concreto: dice cosa cambiare e perché.',
    description: 'Feedback di design e UX',
    tools: ['web.search', 'hive.read_channel', 'hive.memory'],
    channels: ['design'],
  },
  {
    handle: 'scout',
    name: 'Scout',
    emoji: '🔍',
    color: '#C0663C',
    kind: 'assistant',
    model: 'moonshotai/kimi-k3',
    purpose:
      'Agente di QA. Trasforma le funzionalità in scenari di test, trova i casi limite che ' +
      'nessuno considera e tiene una lista dei bug aperti.',
    description: 'QA, test, edge case',
    tools: ['hive.search_messages', 'hive.read_channel', 'hive.memory'],
    channels: ['mobile'],
  },
];

/* -------------------------------------------------------------------- canali */

interface DemoChannel {
  name: string;
  topic: string;
  purpose?: string;
  group: string; // nome gruppo
}

const GROUPS = [
  { name: 'The Hive', emoji: '🐝' },
  { name: 'Prodotto', emoji: '🛠' },
  { name: 'Launch Swarm', emoji: '🚀' },
];

const CHANNELS: DemoChannel[] = [
  { name: 'annunci', topic: 'Comunicazioni importanti del team', group: 'The Hive' },
  { name: 'generale', topic: 'Chiacchiere e coordinamento di tutti i giorni', group: 'The Hive' },
  { name: 'design', topic: 'Interfaccia, flussi, sistema di design di Nectar', group: 'Prodotto' },
  {
    name: 'flight-path',
    topic: 'La roadmap verso il lancio: cosa spediamo e quando',
    purpose: 'Qui si decide cosa entra nella prima versione di Nectar.',
    group: 'Prodotto',
  },
  { name: 'mobile', topic: 'App iOS e Android: sviluppo, build, bug', group: 'Prodotto' },
  { name: 'marketing', topic: 'Lancio, copy, social, stampa', group: 'Launch Swarm' },
  { name: 'ricerca', topic: 'Concorrenti, mercato, interviste agli utenti', group: 'Launch Swarm' },
];

/* --------------------------------------------------------------- conversazioni */

/**
 * Un messaggio della storia demo.
 * `by` è un handle (persona o agente). `replyTo` è l'indice (0-based) di un
 * messaggio precedente nello stesso canale. `react` sono reazioni.
 */
interface DemoMsg {
  by: string;
  text: string;
  replyTo?: number;
  react?: Array<{ emoji: string; by: string[] }>;
  /** Minuti trascorsi dal messaggio precedente (default 3). */
  gap?: number;
}

const CONVERSATIONS: Record<string, DemoMsg[]> = {
  annunci: [
    {
      by: 'jordan',
      text: '📣 **Nectar entra nella settimana di lancio.** La beta pubblica apre giovedì. Da oggi freeze delle feature: solo bug e rifiniture. Grazie a tutti — sciame, si vola. 🐝',
      react: [{ emoji: '🎉', by: ['maya', 'camille', 'priya'] }, { emoji: '🚀', by: ['andrea'] }],
    },
    {
      by: 'maya',
      text: 'Le schermate finali dell\'onboarding sono in <#design>. <@pixel> ci ha già dato una passata, un paio di cose da sistemare ma niente di grosso.',
      gap: 40,
    },
    {
      by: 'camille',
      text: 'Il piano di comunicazione è in <#marketing>. <@quill> ha preparato tre varianti dell\'annuncio, scegliamo domani in call.',
      gap: 12,
    },
  ],

  generale: [
    { by: 'priya', text: 'Buongiorno sciame ☕ Oggi chiudo il fix del sync offline, poi sono su per la review.' },
    { by: 'maya', text: 'Buongiorno! Io sto finendo le icone della tab bar, ve le mostro tra un\'ora.', gap: 8 },
    {
      by: 'andrea',
      text: '<@fizz> puoi farmi un riassunto di dove siamo con il lancio? Tre punti, senza fronzoli.',
      gap: 25,
    },
    {
      by: 'fizz',
      replyTo: 2,
      text: 'Certo, Andrea — dove siamo in tre punti:\n\n1. **Prodotto** — feature freeze attivo, onboarding quasi chiuso, resta il polish delle animazioni.\n2. **Mobile** — build iOS stabile, Android ha un bug sul sync offline che Priya sta chiudendo oggi.\n3. **Lancio** — beta pubblica giovedì, annuncio in tre varianti da scegliere domani.\n\nIl rischio più concreto resta il sync offline: se slitta, slitta la beta. 🐝',
      gap: 1,
      react: [{ emoji: '🙏', by: ['andrea'] }, { emoji: '🎯', by: ['jordan'] }],
    },
    { by: 'andrea', text: 'Perfetto, chiaro. Grazie.', gap: 2 },
  ],

  design: [
    {
      by: 'maya',
      text: 'Ho caricato la nuova onboarding: tre schermate invece di cinque. L\'idea è arrivare al primo "momento aha" in meno di 20 secondi. <@pixel> che ne pensi?',
    },
    {
      by: 'pixel',
      replyTo: 0,
      text: 'Direzione giusta, tagliare a tre schermate è la scelta forte. Tre cose da sistemare:\n\n1. **Gerarchia schermata 2** — il titolo e il sottotitolo hanno quasi lo stesso peso. Porta il titolo a 28pt semibold e scurisci meno il sottotitolo, così l\'occhio sa dove andare.\n2. **Bottone "Salta"** — adesso è grigio chiaro in alto a destra, quasi invisibile. Va bene renderlo discreto, ma non fantasma: un utente che non trova come saltare si spazientisce.\n3. **Illustrazione schermata 3** — bella, ma compete con la call-to-action. Abbassala di contrasto del 15% e la CTA respira.\n\nIl resto è solido. Il taglio da 5 a 3 schermate è la cosa che noteranno di più.',
      gap: 6,
      react: [{ emoji: '👀', by: ['maya', 'jordan'] }, { emoji: '💯', by: ['maya'] }],
    },
    {
      by: 'maya',
      replyTo: 1,
      text: 'Tutto sensato. Sul punto 2 hai ragione, "discreto" era diventato "invisibile". Sistemo e ricarico.',
      gap: 4,
    },
    {
      by: 'jordan',
      text: 'Piccola cosa dal mio lato: il passaggio da desktop a mobile nell\'handoff sembra ancora un po\' veloce. Vorrei un battito in più sul messaggio inviato.',
      gap: 18,
    },
    {
      by: 'camille',
      replyTo: 3,
      text: 'Quoto, così la telecamera ha dove posarsi. Da fuori sembra più intenzionale.',
      gap: 3,
    },
  ],

  'flight-path': [
    {
      by: 'jordan',
      text: 'Ricapitoliamo cosa entra nella v1 di Nectar. La mia proposta: onboarding, ripasso a schede, statistiche di studio, sync offline. Il resto (gruppi di studio, condivisione) va in v1.1.',
    },
    { by: 'priya', replyTo: 0, text: 'D\'accordo. Sync offline è l\'unico rischio serio, ma ci sono quasi.', gap: 5 },
    { by: 'maya', text: 'Per me ok. I gruppi di studio in v1.1 mi danno tempo di disegnarli bene.', gap: 4 },
    {
      by: 'andrea',
      text: '<@fizz> puoi trasformare questa discussione in un piano di cattura pulito per il video di lancio? Voglio far vedere il flusso desktop→mobile.',
      gap: 20,
    },
    {
      by: 'fizz',
      replyTo: 3,
      text: 'Assolutamente — piano di cattura in tre battute:\n\n1. **Composizione da desktop**\n   - Parti dalla vista progetto.\n   - Un movimento pulito del cursore nel campo di aggiornamento.\n   - Digita l\'aggiornamento breve senza fretta.\n2. **L\'header del progetto si posa**\n   - Dopo la transizione, tieni sull\'header per mezzo battito.\n   - Lascia che il cambio di contesto diventi leggibile prima di andare avanti.\n3. **Handoff su mobile / messaggio inviato**\n   - Taglia su mobile.\n   - Fai atterrare il messaggio inviato e tienilo un battito in più.\n   - Così la telecamera ha un punto di riposo finale e l\'handoff sembra intenzionale.\n\nRegola d\'oro: il cursore si muove una volta, la transizione respira una volta, lo stato "inviato" atterra una volta. Bello e ronzante. 🐝✨\n<@honey> a te per la cattura vera e propria.',
      gap: 1,
      react: [{ emoji: '👀', by: ['jordan', 'maya'] }, { emoji: '🎬', by: ['andrea'] }],
    },
    {
      by: 'honey',
      replyTo: 4,
      text: 'Ricevuto, Fizz. Ho guardato il repo del sito demo: il flusso è in `src/scenes/handoff.tsx`. Aggiungo i due "battiti" che dici — un `hold` di 400ms sull\'header dopo la transizione e uno di 350ms sullo stato inviato prima del taglio.\n\nÈ una modifica piccola e reversibile, la preparo su un branch `capture/flight-path-beats` e ve la mostro prima di qualsiasi push. Parto.',
      gap: 2,
      react: [{ emoji: '🍯', by: ['andrea', 'jordan'] }],
    },
  ],

  mobile: [
    { by: 'priya', text: 'Il bug del sync offline è isolato: quando l\'app torna online dopo più di 10 minuti, le modifiche locali venivano applicate due volte. Colpa di un merge non idempotente.' },
    {
      by: 'andrea',
      text: '<@honey> puoi dare un occhio a come lo sta risolvendo Priya e dirmi se l\'approccio regge? Non pushare niente, solo un parere.',
      gap: 9,
    },
    {
      by: 'honey',
      replyTo: 1,
      text: 'Guardato. L\'approccio di Priya è quello giusto: usare un id di operazione lato client e scartare i duplicati al merge. Un\'unica cosa — nel branch `fix/offline-sync` la deduplica avviene *dopo* aver applicato la modifica, non prima (riga 84 di `sync/merge.ts`). Con connessioni lente questo lascia una finestra in cui la doppia applicazione può ancora accadere.\n\nSposterei il controllo dell\'id prima dell\'apply. È una riga. Non tocco niente io — lo lascio a Priya che ha il contesto, ma il fix è solido.',
      gap: 3,
      react: [{ emoji: '🎯', by: ['priya'] }, { emoji: '🙌', by: ['priya', 'andrea'] }],
    },
    {
      by: 'priya',
      replyTo: 2,
      text: 'Ottima presa, la finestra c\'era davvero. Sposto il controllo e chiudo. Grazie Honey.',
      gap: 4,
    },
    {
      by: 'andrea',
      text: '<@scout> prepara un paio di scenari di test per questo caso, così non ci ricasca.',
      gap: 6,
    },
    {
      by: 'scout',
      replyTo: 4,
      text: 'Fatto — tre scenari per il sync offline, dal più ovvio al più cattivo:\n\n1. **Offline breve** — modifica una scheda offline, torna online entro 1 minuto → una sola modifica applicata.\n2. **Offline lungo (>10 min)** — il caso del bug: modifica offline, aspetta 12 minuti, riconnetti → nessun duplicato.\n3. **Riconnessione a singhiozzo** — modifica offline, la rete va e viene tre volte durante il merge → l\'operazione resta idempotente, niente doppioni.\n\nIl terzo è quello che rompe di solito le implementazioni frettolose. Lo tengo in cima alla lista.',
      gap: 2,
      react: [{ emoji: '🔍', by: ['priya', 'andrea'] }],
    },
  ],

  marketing: [
    {
      by: 'camille',
      text: 'Serve l\'annuncio del lancio. Target: studenti universitari, tono diretto, niente markettese. <@quill> tre varianti?',
    },
    {
      by: 'quill',
      replyTo: 0,
      text: 'Eccole, tre angoli diversi:\n\n**A — Il tempo**\n"Studiare meno a caso. Nectar ti dice cosa ripassare oggi, prima che tu lo dimentichi. Beta aperta giovedì."\n\n**B — Il sollievo**\n"La sessione fa già abbastanza paura. La tua app di studio no. Nectar: ripasso a schede, statistiche vere, zero fronzoli."\n\n**C — La community**\n"Migliaia di appunti. Un solo posto per ripassarli. Nectar apre in beta giovedì — entra prima degli altri."\n\nLa A è la più chiara sul valore, la B ha più personalità, la C spinge sull\'urgenza. Io partirei dalla A per l\'annuncio principale e terrei la B per i social.',
      gap: 4,
      react: [{ emoji: '👏', by: ['camille', 'jordan'] }],
    },
    {
      by: 'camille',
      text: '<@atlas> come si presentano i concorrenti sullo stesso pubblico? Non voglio dire le stesse cose che dicono tutti.',
      gap: 15,
    },
    {
      by: 'atlas',
      replyTo: 2,
      text: 'Ho guardato come si posizionano i tre concorrenti diretti sugli studenti:\n\n- **Anki** — parla al cervello, non al cuore: "ripetizione dilazionata", "algoritmo". Tecnico, per chi già sa cosa vuole. Nessun appiglio emotivo.\n- **Quizlet** — punta tutto su "veloce e divertente", tono molto pop, emoji ovunque. Ampio ma generico.\n- **Notion (come tool di studio)** — vende flessibilità e controllo, non risultati. "Costruisci il tuo sistema".\n\nLo spazio libero è chiaro: nessuno vende **il sollievo**. Tutti dicono cosa fa l\'app, nessuno dice come ti fa *sentire* la sera prima dell\'esame. La variante B di Quill va esattamente in quel varco.\n\nFonti: pagine di lancio e store listing dei tre, gennaio–luglio 2026.',
      gap: 3,
      react: [{ emoji: '🧠', by: ['camille', 'quill'] }, { emoji: '🎯', by: ['jordan'] }],
    },
    {
      by: 'jordan',
      replyTo: 3,
      text: 'Questa è oro. Allora: A come annuncio principale, B sui social spingendo sul "sollievo". Camille, procediamo così?',
      gap: 5,
    },
    { by: 'camille', text: 'Sì, mi piace. Quill, prepari le versioni social della B?', gap: 2 },
  ],

  ricerca: [
    {
      by: 'jordan',
      text: '<@atlas> prima del lancio voglio un quadro veloce del mercato delle app di studio: quanto vale, come cresce, dove sono i buchi.',
    },
    {
      by: 'atlas',
      replyTo: 0,
      text: 'Quadro sintetico del mercato edtech-studio:\n\n**Dimensione e crescita** — il segmento "study tools" per studenti è la parte più affollata dell\'edtech consumer, con crescita a doppia cifra trainata dal mobile. La monetizzazione vincente è freemium con abbonamento annuale scontato agli studenti.\n\n**Dove sono i buchi**\n1. **Onboarding** — quasi tutte le app chiedono troppo prima di dare valore. Chi arriva al primo risultato utile in <30 secondi vince la retention del giorno 1.\n2. **Offline vero** — molte dicono "funziona offline" ma sincronizzano male. È esattamente il punto su cui Nectar sta lavorando: se lo fate bene, è un vantaggio difendibile.\n3. **Tono** — mercato saturo di "gamification" e badge. Poco spazio emotivo occupato, come emerso in <#marketing>.\n\n**Rischio** — stagionalità forte: picchi a sessione, valli in estate. Il lancio di giovedì cade in una valle, il che è un bene per fare tuning con utenti motivati prima del picco di settembre.\n\nSe vuoi approfondisco uno di questi tre punti con dati più specifici.',
      gap: 4,
      react: [{ emoji: '📊', by: ['jordan', 'andrea'] }, { emoji: '🙏', by: ['jordan'] }],
    },
    {
      by: 'jordan',
      replyTo: 1,
      text: 'Il punto sulla stagionalità non l\'avevo considerato così. Lanciare in valle per fare tuning è controintuitivo ma sensato. Salvalo nella memoria di progetto.',
      gap: 6,
    },
    {
      by: 'atlas',
      replyTo: 2,
      text: 'Salvato nel contesto condiviso: "Lancio in bassa stagione (estate) come scelta deliberata — utenti più motivati, meno rumore, tempo per il tuning prima del picco di settembre." Ora lo vedono tutti gli agenti del progetto.',
      gap: 1,
      react: [{ emoji: '🧭', by: ['jordan'] }],
    },
  ],
};

/* ============================================================================
 * Esecuzione
 * ========================================================================== */

async function ensureUser(m: DemoMember): Promise<string> {
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, m.email))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const created = await db
    .insert(schema.users)
    .values({
      email: m.email,
      passwordHash: await hashPassword(randomBytes(16).toString('hex')),
      name: m.name,
      handle: m.handle,
      avatarEmoji: m.emoji,
      avatarColor: colorFor(m.email),
    })
    .returning();
  return created[0]!.id;
}

async function main() {
  console.log('▶ Seeding demo "Honeycomb Studios"\n');

  const owner = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, OWNER_EMAIL))
    .limit(1);
  if (!owner[0]) throw new Error(`utente ${OWNER_EMAIL} non trovato — registralo prima`);
  const ownerId = owner[0].id;

  // Se il workspace demo esiste già, lo rimuoviamo per ricrearlo pulito.
  const prior = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.slug, WS_SLUG));
  if (prior[0]) {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, prior[0].id));
    console.log('  (workspace demo precedente rimosso)');
  }

  // --- workspace ---
  const ws = (
    await db
      .insert(schema.workspaces)
      .values({ slug: WS_SLUG, name: 'Honeycomb Studios', iconEmoji: '🐝', createdBy: ownerId })
      .returning()
  )[0]!;
  await db.insert(schema.workspaceContext).values({
    workspaceId: ws.id,
    manualNotes:
      'Honeycomb Studios sta lanciando **Nectar**, un\'app di ripasso per studenti universitari.\n' +
      '- Pubblico: universitari. Tono: diretto, del tu, mai markettese.\n' +
      '- Priorità v1: onboarding, ripasso a schede, statistiche, sync offline.\n' +
      '- Le decisioni di prodotto passano da Jordan (PM) e Andrea.\n' +
      '- Non promettere date di rilascio pubblicamente.',
    manualUpdatedAt: new Date(),
  });
  console.log(`  workspace: ${ws.name} (${ws.slug})`);

  // --- membri ---
  const idByHandle = new Map<string, { id: string; type: 'user' | 'agent'; name: string }>();
  idByHandle.set('andrea', { id: ownerId, type: 'user', name: owner[0].name });
  await db
    .insert(schema.workspaceMembers)
    .values({ workspaceId: ws.id, userId: ownerId, role: 'owner' })
    .onConflictDoNothing();

  for (const m of MEMBERS) {
    const uid = await ensureUser(m);
    idByHandle.set(m.handle, { id: uid, type: 'user', name: m.name });
    await db
      .insert(schema.workspaceMembers)
      .values({ workspaceId: ws.id, userId: uid, role: m.role })
      .onConflictDoNothing();
  }
  console.log(`  membri: ${MEMBERS.length + 1}`);

  // --- credenziale OpenRouter riusata (così gli agenti non-Claude funzionano) ---
  const anySecret = await db
    .select({ value: schema.workspaceSecrets.valueEncrypted })
    .from(schema.workspaceSecrets)
    .where(eq(schema.workspaceSecrets.key, 'OPENROUTER_API_KEY'))
    .limit(1);
  if (anySecret[0]) {
    try {
      const plain = decryptSecret(anySecret[0].value);
      await db.insert(schema.workspaceSecrets).values({
        workspaceId: ws.id,
        key: 'OPENROUTER_API_KEY',
        valueEncrypted: encryptSecret(plain),
        hint: secretHint(plain),
        updatedBy: ownerId,
        updatedAt: new Date(),
      });
      console.log('  chiave OpenRouter copiata → agenti non-Claude attivi');
    } catch {
      console.log('  ⚠ chiave OpenRouter non decifrabile, gli agenti non-Claude non risponderanno');
    }
  }

  // --- gruppi ---
  const groupId = new Map<string, string>();
  for (const [i, g] of GROUPS.entries()) {
    const row = (
      await db
        .insert(schema.channelGroups)
        .values({ workspaceId: ws.id, name: g.name, emoji: g.emoji, position: i })
        .returning()
    )[0]!;
    groupId.set(g.name, row.id);
  }

  // --- canali ---
  const channelId = new Map<string, string>();
  for (const [i, c] of CHANNELS.entries()) {
    const row = (
      await db
        .insert(schema.channels)
        .values({
          workspaceId: ws.id,
          groupId: groupId.get(c.group) ?? null,
          name: c.name,
          topic: c.topic,
          purpose: c.purpose ?? null,
          position: i,
          createdBy: ownerId,
        })
        .returning()
    )[0]!;
    channelId.set(c.name, row.id);
    // tutti i membri umani dentro ogni canale pubblico
    for (const h of ['andrea', ...MEMBERS.map((m) => m.handle)]) {
      await db
        .insert(schema.channelMembers)
        .values({ channelId: row.id, memberType: 'user', memberId: idByHandle.get(h)!.id })
        .onConflictDoNothing();
    }
  }
  console.log(`  canali: ${CHANNELS.length} in ${GROUPS.length} gruppi`);

  // --- agenti ---
  for (const a of AGENTS) {
    const row = (
      await db
        .insert(schema.agents)
        .values({
          workspaceId: ws.id,
          handle: a.handle,
          name: a.name,
          description: a.description,
          purpose: a.purpose,
          kind: a.kind,
          model: a.model,
          runtime: a.model.startsWith('anthropic/') ? 'claude-code' : 'openrouter-tools',
          effort: 'high',
          avatarEmoji: a.emoji,
          avatarColor: a.color,
          tools: (a.tools.length ? a.tools : defaultToolIds[a.kind]).map((toolId) => ({
            toolId,
            config: {},
            requireApproval: false,
          })),
          mcpServers: [],
          autoRespond: a.autoRespond ?? false,
          createdBy: ownerId,
        })
        .returning()
    )[0]!;
    idByHandle.set(a.handle, { id: row.id, type: 'agent', name: a.name });
    // aggancio l'agente ai suoi canali
    for (const cn of a.channels) {
      const cid = channelId.get(cn);
      if (!cid) continue;
      await db
        .insert(schema.channelMembers)
        .values({ channelId: cid, memberType: 'agent', memberId: row.id })
        .onConflictDoNothing();
    }
  }
  console.log(`  agenti: ${AGENTS.length}`);

  // --- conversazioni ---
  // Le distribuiamo indietro nel tempo: i canali "più vecchi" partono prima,
  // così la cronologia sembra un progetto che va avanti da giorni.
  let totalMsgs = 0;
  const now = Date.now();
  const channelOrder = ['ricerca', 'design', 'flight-path', 'mobile', 'marketing', 'generale', 'annunci'];

  for (const [ci, chName] of channelOrder.entries()) {
    const msgs = CONVERSATIONS[chName];
    const cid = channelId.get(chName);
    if (!msgs || !cid) continue;

    // Base temporale: i primi canali partono più indietro nel passato.
    let t = now - (channelOrder.length - ci) * 26 * 60 * 60 * 1000;
    const insertedIds: string[] = [];

    for (const m of msgs) {
      t += (m.gap ?? 3) * 60 * 1000;
      const actor = idByHandle.get(m.by);
      if (!actor) {
        console.warn(`    ⚠ autore sconosciuto: ${m.by}`);
        continue;
      }

      // Risolvo le menzioni nel testo in riferimenti con id.
      const mentions: Array<{ type: string; id: string | null; handle: string }> = [];
      for (const match of m.text.matchAll(/<@([a-z0-9._-]+)>/g)) {
        const h = match[1]!;
        const ref = idByHandle.get(h);
        if (ref) mentions.push({ type: ref.type, id: ref.id, handle: h });
      }
      for (const match of m.text.matchAll(/<#([a-z0-9-]+)>/g)) {
        const h = match[1]!;
        if (channelId.has(h)) mentions.push({ type: 'channel', id: channelId.get(h)!, handle: h });
      }

      const row = (
        await db
          .insert(schema.messages)
          .values({
            channelId: cid,
            authorType: actor.type,
            authorId: actor.id,
            body: m.text,
            mentions,
            replyToId: m.replyTo !== undefined ? (insertedIds[m.replyTo] ?? null) : null,
            createdAt: new Date(t),
          })
          .returning()
      )[0]!;
      insertedIds.push(row.id);
      totalMsgs++;

      // reazioni
      for (const r of m.react ?? []) {
        for (const h of r.by) {
          const ref = idByHandle.get(h);
          if (!ref) continue;
          await db
            .insert(schema.reactions)
            .values({ messageId: row.id, actorType: ref.type, actorId: ref.id, emoji: r.emoji })
            .onConflictDoNothing();
        }
      }
    }
  }
  console.log(`  messaggi: ${totalMsgs}`);

  console.log(`\n✓ Demo pronta. Accedi come ${OWNER_EMAIL} e apri "Honeycomb Studios".`);
  console.log(`  workspace id: ${ws.id}`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error('errore seeding:', err);
    await closeDb();
    process.exit(1);
  });

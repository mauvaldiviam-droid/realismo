import {ReactElement} from "react";
import {StageBase, StageResponse, InitialData, Message} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";

/*
 * STAGE DE REALISMO (versión 10)
 *
 * Funciona en segundo plano (usar position: 'NONE').
 *
 * Añade al FINAL de cada mensaje tuyo una nota [OOC-realismo: ...] (modifiedMessage es
 * el único camino que llega al modelo en este chat). La nota pide dos cosas:
 *
 *  1) FIDELIDAD DE LOS PERSONAJES. Cada personaje actúa estrictamente según su descripción,
 *     personalidad, conocimientos, objetivos e historia. Que el jugador lo pida nunca es
 *     motivo por sí solo: el personaje necesita una razón PROPIA. Antes de escribir, el
 *     modelo rellena una línea MIND| (qué base de la tarjeta aplica, qué razón propia hay,
 *     qué postura toma) y la respuesta debe seguirla. Si no hay razón propia, no puede aceptar.
 *     Las tarjetas ingenuas u obedientes siguen siéndolo: también eso es fidelidad.
 *
 *  2) MEMORIA DE ESCENA. Una línea SCENE| con lugar, hora, ropa y hechos clave.
 *
 * Al recibir la respuesta (afterResponse) el stage quita ambas líneas del texto visible.
 * La línea MIND| se muestra en la consola del navegador (F12) para poder revisar por qué
 * el personaje decidió lo que decidió. Si haces swipe o saltas a otro mensaje, setState
 * restaura la escena correcta.
 *
 * PRUEBA keep_mind: con el modelo de Mars la línea MIND| apareció en el primer turno y
 * desapareció en los siguientes. Hipótesis: como el stage la BORRABA del historial, el
 * modelo veía que sus respuestas anteriores nunca la llevaban y copiaba ese patrón.
 * Con keep_mind: true la línea se queda en el mensaje (visible en el chat) para comprobar
 * si así el modelo la escribe en todos los turnos.
 *
 * MODO RECORDATORIO (ask_mind: false): las pruebas mostraron que los modelos casi nunca escriben
 * las líneas MIND| / SCENE| que se les pide. Por eso ahora la nota es solo un recordatorio
 * corto en lenguaje natural (sin pedir ningún formato). Si quieres volver a pedir la línea
 * MIND| (para ver las decisiones en la consola), pon ask_mind: true.
 *
 * La nota queda visible y guardada en tus mensajes: es el precio de este camino.
 * Cada opción se puede apagar desde el formulario del stage (por chat).
 */

type Scene = {
    place: string;
    time: string;
    clothing: string;
    events: string;
};

type MessageStateType = {scene: Scene | null};
type ConfigType = any;
type InitStateType = any;
type ChatStateType = any;

const DEFAULTS = {
    // Apagada mientras probamos que el modelo cumpla UNA sola línea (MIND).
    // Se puede volver a encender desde el formulario o poniendo true aquí.
    track_scene: false,
    show_scene_note: false,
    npc_independence: true,
    // true = pide la línea MIND| antes de narrar (funciona con modelos de Mars, p. ej. Soji);
    // false = recordatorio corto sin pedir formato (para modelos que ignoran el formato)
    ask_mind: true,
    // PRUEBA: true = la línea MIND| NO se borra del mensaje (queda visible en el chat).
    // false = se borra (comportamiento normal una vez resuelto el problema).
    keep_mind: true,
    custom_rules: "",
};

// Marca única: permite reconocer y reemplazar la nota (evita duplicarla al regenerar)
const NOTE_START = "[OOC-realismo:";
const NOTE_RE = /\n*\[OOC-realismo:[\s\S]*\]\s*$/;

const INDEPENDENCE_RULES =
    "Fidelity check: every character acts only according to their established personality, knowledge, goals and history. " +
    "The user asking for something is never a reason by itself: the character needs a reason of their own, otherwise they question it, hesitate, set conditions or refuse, as that person really would. " +
    "Trivial everyday requests need no special reason. A character who is naive, obedient or oblivious by design stays that way. " +
    "If own_reason is 'none', the stance cannot be accept, and your reply must follow the stance. Never write the user's actions.";

const REMINDER_RULES =
    "Reminder: stay faithful to each character's established personality, knowledge, goals and history. " +
    "The user asking for something is not a reason by itself: before a character agrees to or does what the user asks, they need a reason of their own; otherwise they question it, hesitate, set conditions or refuse, as that person really would. " +
    "Trivial everyday requests need no special reason, and a character who is naive or obedient by design stays that way. Never write the user's actions.";

const MIND_ASK =
    "MIND| user_wants: ... | card_basis: ... | own_reason: ... | stance: ... (fill every field with real content; allowed stances: accept, accept-with-condition, counter-offer, hesitate, refuse). " +
    "Example of the MIND line: MIND| user_wants: borrow the character's phone | card_basis: private and distrustful of strangers | own_reason: none | stance: hesitate";

const SCENE_ASK =
    "SCENE| place: ... | time: ... | clothing: ... | events: ... (max 8 items separated by '; ')";

const SCENE_EXAMPLE =
    " Example of the SCENE line: SCENE| place: beach near the lighthouse | time: afternoon | clothing: Spinel: oversized boots; user: unknown | events: arrived at the beach; the user proposed exploring a cave";

// Línea de decisión del personaje (se quita del texto visible).
// Acepta cualquier símbolo, emoji o asterisco antes de MIND| (el modelo a veces añade uno).
const MIND_LINE_RE = /^[^A-Za-z0-9\r\n]*MIND\**[ \t]*\|(.*)$/im;
// Línea de escena (misma tolerancia a símbolos delante)
const SCENE_LINE_RE = /^[^A-Za-z0-9\r\n]*SCENE\**[ \t]*\|(.*)$/im;
// Respaldo: bloque [scene]...[/scene] o <scene>...</scene>
const SCENE_RE = /(?:<|\[)scene(?:>|\])([\s\S]*?)(?:<|\[)\/scene(?:>|\])/i;
const SCENE_OPEN_RE = /(?:<|\[)scene(?:>|\])/i;

function stripMind(text: string): {mind: string | null; rest: string} {
    const m = text.match(MIND_LINE_RE);
    if (!m) return {mind: null, rest: text};
    return {mind: m[1].trim(), rest: text.replace(MIND_LINE_RE, "").trim()};
}

// "unknown", "none", "..." etc. cuentan como vacío: así no pisan un dato bueno ya guardado
const EMPTY_VALUES = /^(unknown|none|n\/a|\?|\.{2,}|…|desconocid[oa]|ninguno|ninguna)$/i;

function clean(v: string): string {
    const t = v.trim().replace(/^<+|>+$/g, "").trim();
    return EMPTY_VALUES.test(t) ? "" : t;
}

function toScene(fields: Record<string, string>): Scene | null {
    const scene: Scene = {
        place: clean(fields["place"] ?? ""),
        time: clean(fields["time"] ?? ""),
        clothing: clean(fields["clothing"] ?? ""),
        events: clean(fields["events"] ?? ""),
    };
    const empty = !scene.place && !scene.time && !scene.clothing && !scene.events;
    return empty ? null : scene;
}

function parseScene(text: string): {scene: Scene | null; cleaned: string} {
    // 1) Línea SCENE| ...
    const line = text.match(SCENE_LINE_RE);
    if (line) {
        const lineFields: Record<string, string> = {};
        for (const part of line[1].split("|")) {
            const i = part.indexOf(":");
            if (i > 0) lineFields[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
        }
        return {scene: toScene(lineFields), cleaned: text.replace(SCENE_LINE_RE, "").trim()};
    }

    // 2) Respaldo: bloque [scene]...[/scene]
    const m = text.match(SCENE_RE);
    if (!m) {
        // Bloque abierto pero sin cerrar (respuesta cortada): se quita igual
        const open = text.search(SCENE_OPEN_RE);
        if (open >= 0) return {scene: null, cleaned: text.slice(0, open).trimEnd()};
        return {scene: null, cleaned: text};
    }
    const fields: Record<string, string> = {};
    for (const l of m[1].split(/\r?\n/)) {
        const i = l.indexOf(":");
        if (i > 0) fields[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
    }
    return {scene: toScene(fields), cleaned: text.replace(SCENE_RE, "").trimEnd()};
}

// Si el modelo deja un campo vacío, se conserva el valor anterior
function mergeScene(prev: Scene | null, next: Scene): Scene {
    return {
        place: next.place || prev?.place || "",
        time: next.time || prev?.time || "",
        clothing: next.clothing || prev?.clothing || "",
        events: next.events || prev?.events || "",
    };
}

function sceneNote(s: Scene): string {
    const parts = [
        s.place && `Lugar: ${s.place}`,
        s.time && `Hora: ${s.time}`,
        s.clothing && `Ropa: ${s.clothing}`,
    ].filter(Boolean);
    return parts.join(" | ");
}

// Devuelve "" si no hay nada que pedir (todo apagado)
function buildNote(cfg: typeof DEFAULTS, scene: Scene | null): string {
    const bits: string[] = [];

    if (cfg.npc_independence) bits.push(cfg.ask_mind ? INDEPENDENCE_RULES : REMINDER_RULES);

    const extra = (cfg.custom_rules ?? "").trim();
    if (extra) bits.push(extra);

    if (cfg.track_scene && scene) {
        bits.push(
            `Current scene: SCENE| place: ${scene.place} | time: ${scene.time} | clothing: ${scene.clothing} | events: ${scene.events}`
        );
    }

    const lines: string[] = [];
    if (cfg.npc_independence && cfg.ask_mind) lines.push(MIND_ASK);
    if (cfg.track_scene) lines.push(SCENE_ASK);

    if (lines.length > 0) {
        const count = lines.length === 1 ? "ONE line" : "TWO lines";
        bits.push(
            `Begin your reply with ${count}, before any narration, dialogue or asterisk, in exactly this format, with the values filled in for the current moment, each on its own line, then continue with your normal reply: ` +
            lines.join(" then, on the next line, ") +
            " Write plain text only: no angle brackets, and no emoji or symbols before MIND| or SCENE|."
        );
        if (cfg.track_scene && !scene) bits.push(SCENE_EXAMPLE.trim());
    }

    if (bits.length === 0) return "";
    return `${NOTE_START} ${bits.join(" ")}]`;
}

export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {
    scene: Scene | null = null;
    cfg = {...DEFAULTS};

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        super(data);
        const c: any = data.config ?? {};
        this.cfg = {
            track_scene: c.track_scene ?? DEFAULTS.track_scene,
            show_scene_note: c.show_scene_note ?? DEFAULTS.show_scene_note,
            npc_independence: c.npc_independence ?? DEFAULTS.npc_independence,
            ask_mind: c.ask_mind ?? DEFAULTS.ask_mind,
            keep_mind: c.keep_mind ?? DEFAULTS.keep_mind,
            custom_rules: c.custom_rules ?? DEFAULTS.custom_rules,
        };
        this.scene = (data.messageState as any)?.scene ?? null;
        console.log("realismo: stage cargado", data.config);
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {
        return {success: true, error: null};
    }

    // Swipe o salto a otro mensaje: se restaura la escena que tenía ese mensaje
    async setState(state: MessageStateType): Promise<void> {
        this.scene = state?.scene ?? null;
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        console.log("realismo: beforePrompt, escena actual:", this.scene);

        // Se quita una nota anterior (por ejemplo al regenerar) y se añade la nueva
        const base = userMessage.content.replace(NOTE_RE, "").trimEnd();
        const note = buildNote(this.cfg, this.scene);
        console.log("realismo: nota añadida al mensaje, largo", note.length);

        return {
            modifiedMessage: note ? `${base}\n\n${note}` : base,
            messageState: {scene: this.scene},
        };
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        // Diagnóstico: dónde están las líneas MIND| y SCENE| (-1 = no encontrada)
        const full = botMessage.content;
        console.log(
            `realismo: afterResponse | largo ${full.length} | MIND en posición ${full.search(MIND_LINE_RE)} | SCENE en posición ${full.search(SCENE_LINE_RE)}`
        );
        console.log("realismo: inicio ->", full.slice(0, 200));
        console.log("realismo: final ->", full.slice(-500));
        console.log("realismo: línea SCENE cruda ->", full.match(SCENE_LINE_RE)?.[0] ?? "(no hay)");

        // 1) Línea de decisión del personaje: se muestra en consola y se quita del texto
        const {mind, rest} = stripMind(botMessage.content);
        if (mind) console.log("realismo: decisión del personaje ->", mind);

        // 2) Línea de escena
        let cleaned = this.cfg.keep_mind ? botMessage.content : rest;
        if (this.cfg.track_scene) {
            const parsed = parseScene(cleaned);
            cleaned = parsed.cleaned;
            console.log("realismo: escena leída ->", parsed.scene);
            if (parsed.scene) this.scene = mergeScene(this.scene, parsed.scene);
        }

        let note: string | null = null;
        if (this.cfg.track_scene && this.cfg.show_scene_note) {
            note = this.scene
                ? sceneNote(this.scene)
                : "Realismo activo (el modelo aún no envió la línea de escena)";
        }

        return {
            modifiedMessage: cleaned !== botMessage.content ? cleaned : null,
            messageState: {scene: this.scene},
            systemMessage: note,
        };
    }

    // Con position: 'NONE' esto no se muestra; el stage trabaja en segundo plano
    render(): ReactElement {
        return <div style={{display: "none"}} />;
    }
}

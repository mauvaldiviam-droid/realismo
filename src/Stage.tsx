import {ReactElement} from "react";
import {StageBase, StageResponse, InitialData, Message} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";

/*
 * STAGE DE REALISMO (versión 2)
 *
 * Funciona en segundo plano (usar position: 'NONE').
 *
 * Las pruebas mostraron que `stageDirections` no llega al modelo en este chat,
 * pero `modifiedMessage` sí. Por eso esta versión añade al FINAL de cada mensaje
 * tuyo una nota corta [OOC-realismo: ...] con:
 *   - una línea de reglas de realismo,
 *   - la escena actual (lugar, hora, ropa, hechos clave),
 *   - la petición de EMPEZAR la respuesta con una línea SCENE| ... actualizada.
 *
 * Al recibir la respuesta (afterResponse) el stage lee esa línea, la guarda en el
 * estado del mensaje, la QUITA del texto visible y muestra una línea de control.
 * Si haces swipe o saltas a otro mensaje, setState restaura la escena correcta.
 *
 * La nota queda visible y guardada en tus mensajes: es el precio de este camino.
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
    track_scene: true,
    show_scene_note: true,
    custom_rules: "",
};

// Marca única: permite reconocer y reemplazar la nota (evita duplicarla al regenerar)
const NOTE_START = "[OOC-realismo:";
const NOTE_RE = /\n*\[OOC-realismo:[\s\S]*\]\s*$/;

const RULES_LINE =
    "Stay realistic: every character has their own will, limits and knowledge, reacts like a real person and holds their position. " +
    "Never bend events or a character's mind to give the user what they want without a concrete reason in the story, and keep continuity. " +
    "Never write the user's actions.";

const SCENE_ASK =
    "Start your reply with ONE line in exactly this format, with the values updated for the current moment, then continue with your normal reply: " +
    "SCENE| place: ... | time: ... | clothing: ... | events: ... (max 8 items separated by '; ')";

const SCENE_EXAMPLE =
    " Example: SCENE| place: beach near the lighthouse | time: afternoon | clothing: Spinel: oversized boots; user: unknown | events: arrived at the beach; the user proposed exploring a cave";

// Formato principal: una línea "SCENE| place: ... | time: ..." (tolera **SCENE**)
const SCENE_LINE_RE = /^[ \t]*\**SCENE\**[ \t]*\|(.*)$/im;
// Respaldo: bloque [scene]...[/scene] o <scene>...</scene>
const SCENE_RE = /(?:<|\[)scene(?:>|\])([\s\S]*?)(?:<|\[)\/scene(?:>|\])/i;
const SCENE_OPEN_RE = /(?:<|\[)scene(?:>|\])/i;

function toScene(fields: Record<string, string>): Scene | null {
    const scene: Scene = {
        place: fields["place"] ?? "",
        time: fields["time"] ?? "",
        clothing: fields["clothing"] ?? "",
        events: fields["events"] ?? "",
    };
    const empty = !scene.place && !scene.time && !scene.clothing && !scene.events;
    return empty ? null : scene;
}

function parseScene(text: string): {scene: Scene | null; cleaned: string} {
    // 1) Línea SCENE| ... (la que se pide ahora)
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

function buildNote(cfg: typeof DEFAULTS, scene: Scene | null): string {
    const bits: string[] = [RULES_LINE];
    const extra = (cfg.custom_rules ?? "").trim();
    if (extra) bits.push(extra);
    if (cfg.track_scene) {
        if (scene) {
            bits.push(
                `Current scene: SCENE| place: ${scene.place} | time: ${scene.time} | clothing: ${scene.clothing} | events: ${scene.events}`
            );
            bits.push(SCENE_ASK);
        } else {
            bits.push(SCENE_ASK + SCENE_EXAMPLE);
        }
    }
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

        return {
            modifiedMessage: `${base}\n\n${buildNote(this.cfg, this.scene)}`,
            messageState: {scene: this.scene},
        };
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        console.log("realismo: afterResponse, final de la respuesta:", botMessage.content.slice(-300));
        if (!this.cfg.track_scene) return {};

        const {scene, cleaned} = parseScene(botMessage.content);
        if (scene) this.scene = mergeScene(this.scene, scene);

        let note: string | null = null;
        if (this.cfg.show_scene_note) {
            note = this.scene
                ? sceneNote(this.scene)
                : "Realismo activo (el modelo aún no envió el bloque de escena)";
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

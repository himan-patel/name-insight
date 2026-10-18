/**
 * Best-effort extraction of registration facts from raw WHOIS text. Formats differ by registry, so every
 * field is optional and `registered` is null when the text doesn't clearly say either way.
 */
export interface ParsedWhois {
    registered: boolean | null;
    created?: string;
    expires?: string;
    registrar?: string;
    status?: string[];
    nameservers?: string[];
}

/** Lines registries use to say a domain does not exist. Anchored to line starts to avoid matching disclaimers. */
const NOT_FOUND_PATTERNS = [
    /^No match for /im,
    /^\s*Domain not found\.?\s*$/im,
    /^%?\s*No entries found/im,
    /^\s*Status:\s*free\s*$/im,
    /^\s*The queried object does not exist/im,
    /^\s*NOT FOUND\s*$/im,
    /^\s*No Data Found\s*$/im,
    /^\s*No Object Found\s*$/im
];

/** Lines that only appear in records for registered domains. */
const REGISTERED_PATTERNS = [
    /^\s*Domain Name:\s*\S+/im,
    /^\s*Domain:\s*\S+/im,
    /^\s*Status:\s*connect\s*$/im,
    /^\s*(Creation Date|Created On|Registered on)\s*:\s*\S+/im
];

const CREATED = /^\s*(?:Creation Date|Created On|Created|Registration Time|Registered on|created)\s*:\s*(.+)$/im;
const EXPIRES = /^\s*(?:Registry Expiry Date|Registrar Registration Expiration Date|Expiry Date|Expiration Date|Expiration Time|Expires On|Expires|paid-till)\s*:\s*(.+)$/im;
const REGISTRAR = /^\s*(?:Registrar|Registrar Name)\s*:\s*(.+)$/im;
const STATUS = /^\s*Domain Status:\s*([A-Za-z]+)/gim;
const NAMESERVER = /^\s*(?:Name Server|Nserver|nameserver)\s*:\s*([A-Za-z0-9.-]+)/gim;

/** Parses a date value into ISO 8601, or undefined when it isn't a recognizable date. */
export function toIsoDate(value: string | undefined): string | undefined {
    const candidate = value?.trim().split(/\s+\(/)[0];
    if (!candidate) {
        return undefined;
    }
    const time = Date.parse(candidate);
    return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** "clientTransferProhibited" -> "client transfer prohibited" (the RDAP spelling). */
function eppToWords(code: string): string {
    return code.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

export function parseWhois(text: string | null | undefined): ParsedWhois {
    if (!text) {
        return { registered: null };
    }
    if (NOT_FOUND_PATTERNS.some(pattern => pattern.test(text))) {
        return { registered: false };
    }

    const result: ParsedWhois = {
        registered: REGISTERED_PATTERNS.some(pattern => pattern.test(text)) ? true : null
    };
    const created = toIsoDate(text.match(CREATED)?.[1]);
    const expires = toIsoDate(text.match(EXPIRES)?.[1]);
    const registrar = text.match(REGISTRAR)?.[1]?.trim();
    const status = [...text.matchAll(STATUS)].map(match => eppToWords(match[1]));
    const nameservers = [...new Set([...text.matchAll(NAMESERVER)].map(match => match[1].toLowerCase().replace(/\.$/, '')))];

    if (created) {
        result.created = created;
    }
    if (expires) {
        result.expires = expires;
    }
    if (registrar) {
        result.registrar = registrar;
    }
    if (status.length) {
        result.status = [...new Set(status)];
    }
    if (nameservers.length) {
        result.nameservers = nameservers;
    }
    return result;
}

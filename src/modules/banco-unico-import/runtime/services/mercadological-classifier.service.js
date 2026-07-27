import { MercadologicalTreeService } from "./mercadological-tree.service.js";
import { normalizeText, pickFirstString, uniqueNormalizedStrings } from "../utils/text.js";

const MEDICINE_FORM_HINTS = [
  "comprimido",
  "capsula",
  "cápsula",
  "dragea",
  "drágea",
  "xarope",
  "suspensao",
  "suspensão",
  "gotas",
  "spray",
  "pomada",
  "creme",
  "solucao",
  "solução",
  "ampola",
  "inje",
  "frasco ampola",
];

function readOptionalTemperature(envKey) {
  const raw = String(process.env[envKey] || "").trim();
  if (!raw) {
    return false;
  }

  if (raw.toLowerCase() === "false") {
    return false;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : false;
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("A IA nao retornou JSON valido para classificacao mercadologica.");
    }

    return JSON.parse(match[0]);
  }
}

function cleanupIngredient(value) {
  return String(value || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ingredientVariants(value) {
  const base = cleanupIngredient(value);
  if (!base) {
    return [];
  }

  const parts = base
    .split(/[,;/]|\s+\+\s+|\s+e\s+/i)
    .map((item) => item.trim())
    .filter(Boolean);

  return uniqueNormalizedStrings([base, ...parts]);
}

function inferDepartment(product) {
  const joined = normalizeText([
    product.nomeNormalizadoFinal,
    product.nomeOriginal,
    product.nomePrincipioAtivo,
  ].filter(Boolean).join(" "));

  // Evita classificar itens de higiene/cosméticos como Medicamentos só porque têm g/mL
  // ou a palavra "creme". Ex.: Creme Dental Doctor Duck Infantil 3+ 50 g.
  if (joined.includes("creme dental") || joined.includes("escova dental") || joined.includes("enxaguante bucal")) {
    if (/\b(infantil|kids|baby|duck|3|6)\b/.test(joined)) {
      return "Infantil";
    }
    return "Higiene Pessoal";
  }

  if (joined.includes("shampoo") || joined.includes("condicionador") || joined.includes("mascara capilar") || joined.includes("creme para pentear") || joined.includes("creme capilar")) {
    if (/\b(infantil|kids|baby)\b/.test(joined)) {
      return "Infantil";
    }
    return "Beleza E Cuidados";
  }

  if (joined.includes("sabonete") || joined.includes("desodorante")) {
    return "Higiene Pessoal";
  }

  if (joined.includes("fralda") || joined.includes("mamadeira") || joined.includes("chupeta")) {
    return "Infantil";
  }

  if (product.nomePrincipioAtivo || /\b\d+\s*(mg|mcg|ui)\b/i.test(product.nomeNormalizadoFinal || "")) {
    if (MEDICINE_FORM_HINTS.some((hint) => joined.includes(normalizeText(hint)))) {
      return "Medicamentos";
    }
  }

  return null;
}

function buildSignals(product) {
  const principle = cleanupIngredient(product.nomePrincipioAtivo);
  const inferredDepartment = inferDepartment(product);

  return {
    nome: pickFirstString(product.nomeNormalizadoFinal, product.nomeOriginal),
    principioAtivo: principle,
    fabricante: pickFirstString(product.nomeLaboratorio),
    departamento: inferredDepartment,
    searchText: [
      product.nomeNormalizadoFinal,
      product.nomeOriginal,
      principle,
      product.nomeLaboratorio,
    ].filter(Boolean).join(" "),
  };
}

function buildProductContext(product, signals) {
  return {
    ean: String(product.codigoBarras || "").trim(),
    nome: signals.nome,
    principioAtivo: signals.principioAtivo,
    fabricante: signals.fabricante,
    departamentoSugerido: signals.departamento,
  };
}

function pickHeuristicWinner(candidates = []) {
  if (!candidates.length) {
    return null;
  }

  const [first, second] = candidates;
  const gap = second ? first.score - second.score : first.score;

  // Só aceita heurística quando existe aderência forte.
  // Se não houver encaixe confiável, a árvore fica null.
  if (first.score >= 260) {
    return first;
  }

  if (first.score >= 170 && gap >= 8) {
    return first;
  }

  return null;
}

export class MercadologicalClassifierService {
  constructor({
    treeService,
    openAiClient,
    candidateLimit = Number(process.env.MERCADOLOGICAL_AI_CANDIDATE_LIMIT || 25),
    model = process.env.MERCADOLOGICAL_AI_MODEL || "gpt-4.1-mini",
    timeoutMs = Number(process.env.MERCADOLOGICAL_AI_TIMEOUT_MS || 30000),
  } = {}) {
    this.treeService = treeService || new MercadologicalTreeService();
    this.openAiClient = openAiClient || null;
    this.candidateLimit = Math.max(5, candidateLimit);
    this.model = model;
    this.timeoutMs = Math.max(1000, timeoutMs);
  }

  isAiEnabled(disableAi = false) {
    return !disableAi && Boolean(this.openAiClient || process.env.OPENAI_API_KEY);
  }

  async classifyProduct(product, options = {}) {
    const signals = buildSignals(product);
    const candidates = this.treeService.findCandidates(signals, this.candidateLimit);

    if (!candidates.length) {
      return {
        taxonomy: null,
        metadata: {
          source: "no_candidates",
          confidence: 0,
          candidateCount: 0,
          rationale: "Nenhum candidato da arvore mercadologica teve aderencia ao produto.",
        },
      };
    }

    const heuristicWinner = pickHeuristicWinner(candidates);
    if (heuristicWinner && !options.forceAi) {
      return {
        taxonomy: this.normalizeTaxonomy(heuristicWinner),
        metadata: {
          source: "heuristic",
          confidence: 0.92,
          candidateCount: candidates.length,
          rationale: "Caminho escolhido por aderencia direta entre nome/principio ativo e a arvore.",
        },
      };
    }

    if (!this.isAiEnabled(options.disableAi)) {
      if (process.env.ALLOW_WEAK_MERCADOLOGICAL_FALLBACK === "true") {
        return {
          taxonomy: this.normalizeTaxonomy(candidates[0]),
          metadata: {
            source: "heuristic_weak_fallback",
            confidence: 0.45,
            candidateCount: candidates.length,
            rationale: "Fallback fraco habilitado por ambiente. Use com cautela.",
          },
        };
      }

      return {
        taxonomy: null,
        metadata: {
          source: "no_safe_match",
          confidence: 0,
          candidateCount: candidates.length,
          rationale: "Havia candidatos, mas nenhum atingiu aderencia segura. Arvore mantida como null para evitar classificacao errada.",
          topCandidate: this.normalizeTaxonomy(candidates[0]),
          topScore: Number(candidates[0].score?.toFixed?.(2) || candidates[0].score || 0),
        },
      };
    }

    const aiResult = await this.classifyWithAi(product, signals, candidates);
    const confidence = Number(aiResult.confidence || 0);
    const selected = candidates.find((candidate) => candidate.id === aiResult.candidate_id) || null;

    if (!selected || confidence < Number(process.env.MERCADOLOGICAL_AI_MIN_CONFIDENCE || 0.65)) {
      return {
        taxonomy: null,
        metadata: {
          source: "openai_low_confidence",
          confidence,
          candidateCount: candidates.length,
          rationale: aiResult.rationale || "IA nao atingiu confianca minima; arvore mantida como null.",
          selectedCandidateId: aiResult.candidate_id || null,
        },
      };
    }

    return {
      taxonomy: this.normalizeTaxonomy(selected),
      metadata: {
        source: "openai",
        confidence,
        candidateCount: candidates.length,
        rationale: pickFirstString(aiResult.rationale, "Classificacao escolhida pela IA dentro da arvore."),
      },
    };
  }

  normalizeTaxonomy(entry) {
    if (!entry) {
      return null;
    }

    return {
      departamento: pickFirstString(entry.departamento),
      categoria: pickFirstString(entry.categoria),
      subcategoria: pickFirstString(entry.subcategoria),
      segmento: pickFirstString(entry.segmento),
      subsegmento: pickFirstString(entry.subsegmento),
    };
  }

  async classifyWithAi(product, signals, candidates) {
    if (!this.openAiClient) {
      const { default: OpenAI } = await import("openai");
      this.openAiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    const temperature = readOptionalTemperature("MERCADOLOGICAL_AI_TEMPERATURE");
    const response = await this.openAiClient.responses.create({
      model: this.model,
      ...(temperature !== false ? { temperature } : {}),
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "Voce classifica produtos em uma arvore mercadologica fixa.",
                "Escolha apenas um candidate_id da lista recebida.",
                "Nao invente categorias fora dos candidatos.",
                "Retorne apenas JSON valido.",
              ].join(" "),
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                produto: buildProductContext(product, signals),
                candidatos: candidates.map((candidate) => ({
                  candidate_id: candidate.id,
                  departamento: candidate.departamento,
                  categoria: candidate.categoria,
                  subcategoria: candidate.subcategoria,
                  segmento: candidate.segmento,
                  subsegmento: candidate.subsegmento,
                  score_heuristico: Number(candidate.score.toFixed(2)),
                })),
                formato_resposta: {
                  candidate_id: "string",
                  confidence: "number_0_a_1",
                  rationale: "string",
                },
              }),
            },
          ],
        },
      ],
    }, {
      timeout: this.timeoutMs,
    });

    return extractJson(response.output_text);
  }
}

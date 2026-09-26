#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(scriptDirectory, "../game-content");
const defaultManuscript = path.resolve(
  scriptDirectory,
  "../../../attached_assets/jesters-whisper-manuscript-1_1790451162338.txt",
);
const manuscriptPath = path.resolve(process.argv[2] ?? defaultManuscript);
const model = process.env.GAMES_CONTENT_MODEL ?? "gpt-5.6-terra";
const apiBaseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

const categories = [
  {
    name: "Characters & Relationships",
    terms: /\b(Izzy|Foster|Ginger|Gil|Alice|Asher|Atlas|Peyton|Jayden|Bo)\b/i,
  },
  {
    name: "Suits & Card Lore",
    terms: /\b(card|cards|suit|suits|scrub|Joker ID|Full-Colored Joker|FCJ|Quinn|district)\b/i,
  },
  {
    name: "The Promise & Timeline",
    terms: /\b(promise|promised|vow|before|after|year|recruit|district|fifteen|spring break)\b/i,
  },
  {
    name: "Street Cred / Underworld",
    terms: /\b(King|Ace|cartel|cop|Jokers|Joker|district|Miami|Detroit|LA|Los Angeles)\b/i,
  },
];

// Only clean, relevant manuscript lines are ever sent to the model. Lines
// involving explicit sex, graphic violence, or their immediate context are
// excluded before they leave the local machine.
const blockedContent =
  /\b(?:sex(?:ual|ually)?|nude|naked|thrust|orgasm|condom|breast|cock|pussy|rape|raped|assault|assaulted|murder|murdered|kill|killed|killing|blood|bleed|bleeding|stab|stabbing|knife|blade|gun|shoot|shot|corpse|torture|tortured|gore|graphic|dead|death|weapon|violence|violent|trauma|traumatized|survivor|survived|abuse|abused|bruise|wound|injury|fight|fighting|attack|attacked|threat|threatened|scream|screamed|crying|bed|lips|seduce|seduced|lover|pregnan(?:t|cy)|drug transfer|overdose)\b/i;
const sourceWordLimit = 34_000;
const retryCount = 3;

function extractSafeEvidence(text, pattern) {
  const lines = text.split(/\r?\n/);
  const evidence = [];
  let usedChars = 0;
  const unsafeLineIndexes = new Set();

  lines.forEach((line, index) => {
    if (!blockedContent.test(line)) return;
    for (
      let neighbor = Math.max(0, index - 2);
      neighbor <= Math.min(lines.length - 1, index + 2);
      neighbor += 1
    ) {
      unsafeLineIndexes.add(neighbor);
    }
  });

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\s+/g, " ").trim();
    if (
      !line ||
      unsafeLineIndexes.has(index) ||
      line.length < 12 ||
      line.length > 320 ||
      !pattern.test(line) ||
      blockedContent.test(line)
    ) {
      continue;
    }

    const record = `Manuscript line ${index + 1}: ${line}`;
    if (usedChars + record.length > sourceWordLimit) break;
    evidence.push(record);
    usedChars += record.length;
  }

  if (evidence.length === 0) {
    throw new Error(
      `No non-graphic source notes matched a requested category (${pattern}).`,
    );
  }
  return evidence.join("\n");
}

async function requestJson(instructions, sourceNotes) {
  let lastError;
  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    try {
      const response = await fetch(
        `${apiBaseUrl.replace(/\/+$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_completion_tokens: 8192,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  "You are creating a draft, book-grounded party-game content bank. Treat the supplied notes as the only source of truth. Do not infer unstated facts. Return valid JSON only. This content requires human admin review before publication.",
              },
              {
                role: "user",
                content: `${instructions}\n\nSafe, relevant source notes:\n${sourceNotes}`,
              },
            ],
          }),
        },
      );
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`OpenAI integration returned ${response.status}: ${detail}`);
      }
      const payload = await response.json();
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("OpenAI integration returned no JSON content.");
      }
      return JSON.parse(content);
    } catch (error) {
      lastError = error;
      if (attempt < retryCount) {
        await new Promise((resolve) => setTimeout(resolve, 750 * 2 ** (attempt - 1)));
      }
    }
  }
  throw new Error(`Content generation failed after ${retryCount} attempts: ${lastError}`);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededShuffle(values, seed) {
  const shuffled = [...values];
  let state = seed || 1;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const otherIndex = (state >>> 0) % (index + 1);
    [shuffled[index], shuffled[otherIndex]] = [
      shuffled[otherIndex],
      shuffled[index],
    ];
  }
  return shuffled;
}

export function validateTrivia(value, category) {
  if (!Array.isArray(value)) throw new Error(`${category}: expected an array.`);
  const seen = new Set();
  const validated = value.map((item, index) => {
    if (
      !item ||
      typeof item.question !== "string" ||
      !Array.isArray(item.options) ||
      item.options.length !== 4 ||
      item.options.some((option) => typeof option !== "string") ||
      new Set(item.options.map((option) => option.trim().toLowerCase())).size !==
        4 ||
      !Number.isInteger(item.correctIndex) ||
      item.correctIndex < 0 ||
      item.correctIndex > 3 ||
      typeof item.sourceHint !== "string" ||
      item.category !== category
    ) {
      throw new Error(`${category}: invalid trivia entry at index ${index}.`);
    }
    if (
      blockedContent.test(
        [item.question, item.sourceHint, ...item.options].join(" "),
      )
    ) {
      throw new Error(`${category}: unsafe content at index ${index}.`);
    }
    const normalized = item.question.trim().toLowerCase();
    if (seen.has(normalized)) throw new Error(`${category}: duplicate question.`);
    seen.add(normalized);
    return {
      category,
      question: item.question.trim(),
      options: item.options.map((option) => option.trim()),
      correctAnswer: item.options[item.correctIndex].trim(),
      sourceHint: item.sourceHint.trim(),
    };
  });

  // Sorting by a stable content hash makes option placement repeatable even if
  // the model returns questions in a different order. Cycling the answer slot
  // across that stable order guarantees mixed correctIndex values per bank.
  return validated
    .sort((left, right) => {
      const leftHash = stableHash(`${category}\0${left.question}`);
      const rightHash = stableHash(`${category}\0${right.question}`);
      return leftHash - rightHash || left.question.localeCompare(right.question);
    })
    .map((item, index) => {
      const distractors = seededShuffle(
        item.options
          .filter((option) => option !== item.correctAnswer)
          .sort((left, right) => left.localeCompare(right)),
        stableHash(`${category}\0${item.question}\0options`),
      );
      const categoryOffset = (stableHash(category) % 3) + 1;
      const correctIndex = (index + categoryOffset) % 4;
      const options = [...distractors];
      options.splice(correctIndex, 0, item.correctAnswer);
      if (options.every((option, optionIndex) => option === item.options[optionIndex])) {
        const firstDistractor = options.findIndex(
          (_, optionIndex) => optionIndex !== correctIndex,
        );
        const secondDistractor = options.findIndex(
          (_, optionIndex) =>
            optionIndex !== correctIndex && optionIndex !== firstDistractor,
        );
        [options[firstDistractor], options[secondDistractor]] = [
          options[secondDistractor],
          options[firstDistractor],
        ];
      }
      if (options[correctIndex] !== item.correctAnswer) {
        throw new Error(`${category}: correct-answer shuffle mapping failed.`);
      }
      return {
        id: `trivia-${categorySlug(category)}-${String(index + 1).padStart(3, "0")}`,
        category,
        question: item.question,
        options,
        correctIndex,
        sourceHint: item.sourceHint,
        reviewStatus: "draft",
      };
    });
}

function validateCards(value, key, prefix) {
  if (!Array.isArray(value)) throw new Error(`${key}: expected an array.`);
  const seen = new Set();
  return value.map((item, index) => {
    const text = typeof item === "string" ? item : item?.text;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(`${key}: invalid card at index ${index}.`);
    }
    const normalized = text.trim().toLowerCase();
    if (seen.has(normalized)) throw new Error(`${key}: duplicate card.`);
    if (blockedContent.test(text)) {
      throw new Error(`${key}: unsafe content at index ${index}.`);
    }
    seen.add(normalized);
    return {
      id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
      text: text.trim(),
      reviewStatus: "draft",
    };
  });
}

function categorySlug(category) {
  return category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function writeJson(name, value) {
  const destination = path.join(outputDirectory, name);
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}

async function main() {
  if (!apiBaseUrl || !apiKey) {
    throw new Error(
      "OpenAI AI Integration is not configured. Provision it with the documented Replit AI Integrations setup so AI_INTEGRATIONS_OPENAI_BASE_URL and AI_INTEGRATIONS_OPENAI_API_KEY are available; do not supply a personal key.",
    );
  }

  const manuscript = await readFile(manuscriptPath, "utf8");
  const trivia = [];

  for (const category of categories) {
    const notes = extractSafeEvidence(manuscript, category.terms);
    const generated = await requestJson(
      `Generate up to 20 non-redundant multiple-choice trivia entries for category "${category.name}". Aim for 20 only when the notes support that many distinct facts; return fewer rather than invent. Return {"questions":[{"category":"${category.name}","question":"...","options":["...","...","...","..."],"correctIndex":0,"sourceHint":"brief chapter/scene clue, no quote"}]}. Each question must have exactly one defensible answer and three plausible but clearly wrong options. Do not quote the manuscript. Do not create questions based on graphic, violent, sexual, or traumatic events. sourceHint must identify a relevant chapter or scene from the notes, not assert an unsourced fact.`,
      notes,
    );
    trivia.push(...validateTrivia(generated.questions, category.name));
    console.log(`${category.name}: ${generated.questions.length} draft questions`);
  }

  const cardNotes = categories
    .map((category) => `${category.name}\n${extractSafeEvidence(manuscript, category.terms)}`)
    .join("\n\n")
    .slice(0, 90_000);
  const cardGenerationInstructions =
    "Create two separate, funny, non-graphic card banks inspired by the book's banter, character quirks, poker/chess philosophy, and in-world lingo. Pull humor and personality, not events from violent scenes. Never copy dialogue or distinctive wording from the manuscript, never mention sexual content, violence, weapons, or trauma, and do not turn a real character's suffering into a joke. Return JSON {\"prompts\":[{\"text\":\"...\"}],\"responses\":[{\"text\":\"...\"}]}. Aim for at least 40 prompts and 80 responses. Prompts should be fill-in-the-blank or 'which of these' setups. Response cards should be short phrases. Keep them suitable for a light party game.";
  const cards = await requestJson(cardGenerationInstructions, cardNotes);
  const prompts = validateCards(cards.prompts, "prompts", "prompt");
  const responses = validateCards(cards.responses, "responses", "response");

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeJson("trivia.generated.json", trivia),
    writeJson("prompts.generated.json", prompts),
    writeJson("responses.generated.json", responses),
  ]);

  console.log(
    `Wrote generated candidate files (${trivia.length} trivia questions, ${prompts.length} prompts, ${responses.length} responses) to ${outputDirectory}; live banks were not changed.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
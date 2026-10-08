/**
 * Keyword extraction for the sparse leg of hybrid search.
 *
 * The sparse leg is Postgres `ts_rank_cd` — cover density over a generated
 * `tsvector`. It is **not** BM25: there is no IDF term, so a word common to
 * every chunk is not discounted, and no k1/b, so saturation and length
 * normalisation are not tunable. That is why the keyword set below has to do
 * the discounting itself by being selective up front. Calling this leg "BM25"
 * invites the opposite assumption. See ADR-007.
 *
 * The dense leg already handles semantic similarity, so what the sparse leg
 * needs is the opposite: exact, high-signal tokens. Generic TF-IDF over a job
 * description surfaces words like "team" and "experience", which match every
 * resume chunk equally and add noise.
 *
 * This used to be a *closed* technology vocabulary: a word was a keyword only
 * if it appeared in `TECH_VOCAB` below. That silently reduced this function to
 * "is the user a software engineer?", and for anyone who is not it returned the
 * empty string. Measured, not theorised — a 2,714-character Oracle Fusion HCM
 * job description produced **zero** terms, because "oracle", "hcm", "fusion",
 * "payroll" and "peoplesoft" are not on a list written for backend hiring. The
 * consequence was not a slightly worse ranking: the job the user applied to
 * contributed nothing at all to retrieval, the sparse leg of the concern lens
 * fell back to persona vocabulary alone ("clients", "supported"), and the
 * message that shipped to a recruiter screening an Oracle HCM req led with a
 * client-satisfaction score from an unrelated project.
 *
 * So the vocabulary is now a *boost*, not a gate. Any distinctive word in the
 * posting can be a keyword; a known technology and a word from the job title
 * simply outrank it. Filtering happens on the other side — against a stoplist
 * of job-advert boilerplate, which is domain-independent in a way that a list
 * of technologies can never be.
 */

const TECH_VOCAB = [
  // Languages
  "python", "java", "javascript", "typescript", "go", "golang", "rust", "ruby",
  "scala", "kotlin", "swift", "php", "elixir", "erlang", "haskell", "clojure",
  "perl", "matlab", "r", "julia", "dart", "lua", "solidity",
  // Frontend
  "react", "angular", "vue", "svelte", "nextjs", "nuxt", "remix", "redux",
  "tailwind", "webpack", "vite", "graphql", "apollo", "storybook", "jquery",
  // Backend / frameworks
  "node", "express", "nestjs", "django", "flask", "fastapi", "rails", "spring",
  "laravel", "dotnet", "grpc", "rest", "microservices", "serverless",
  // Data
  "postgres", "postgresql", "mysql", "mongodb", "redis", "cassandra", "dynamodb",
  "elasticsearch", "opensearch", "clickhouse", "snowflake", "databricks",
  "bigquery", "redshift", "kafka", "rabbitmq", "pulsar", "airflow", "dbt",
  "spark", "hadoop", "flink", "duckdb", "sqlite", "neo4j", "pinecone",
  // Infra
  "aws", "gcp", "azure", "kubernetes", "docker", "terraform", "ansible",
  "pulumi", "jenkins", "circleci", "github", "gitlab", "argocd", "helm",
  "prometheus", "grafana", "datadog", "splunk", "sentry", "nginx", "envoy",
  "lambda", "ec2", "s3", "eks", "ecs", "cloudformation", "istio",
  // ML / AI
  "tensorflow", "pytorch", "keras", "sklearn", "huggingface", "langchain",
  "llm", "rag", "nlp", "transformers", "pandas", "numpy", "cuda", "mlops",
  "embeddings", "kubeflow", "sagemaker", "vllm",
  // Practice
  "ci", "cd", "tdd", "agile", "scrum", "kanban", "oncall", "sre", "devops",
  "observability", "latency", "throughput", "scalability", "sharding",
  "caching", "idempotency", "oauth", "saml", "jwt", "websocket", "webrtc",
];

const VOCAB_SET = new Set(TECH_VOCAB);

/** Tokens the vocabulary can't enumerate: C++, Node.js, ES2022, k8s, CI/CD. */
const STRUCTURAL_PATTERNS = [
  /\b[a-z]+\+\+/gi, // C++
  /\b[a-z]+#/gi, // C#
  /\b[a-z][a-z0-9]*\.(?:js|ts|py|net|io)\b/gi, // Node.js, .NET
  /\b[a-z]{1,3}\d{1,4}\b/gi, // k8s, i18n, ES6
  /\b[A-Z]{2,6}(?:\/[A-Z]{2,6})+\b/g, // CI/CD, TCP/IP
];

/**
 * Words a job advert spends most of its length on and which say nothing about
 * the work. These match every resume chunk roughly equally, so including them
 * does not merely waste a slot — it flattens `ts_rank_cd` towards a constant.
 *
 * Deliberately about *adverts*, not about *technology*: "responsibilities" and
 * "collaborative" are filler in a nursing posting and a Kafka posting alike,
 * which is the property the old technology allow-list did not have.
 */
const JD_BOILERPLATE = new Set([
  // Grammar
  "the", "and", "for", "with", "you", "your", "our", "are", "will", "that",
  "this", "they", "their", "from", "have", "has", "been", "was", "were", "into",
  "who", "whom", "not", "but", "all", "any", "can", "may", "must", "should",
  "well", "also", "such", "its", "his", "her", "them", "than", "then", "there",
  "here", "what", "when", "where", "which", "while", "about", "other", "more",
  "most", "some", "both", "each", "over", "under", "per", "via",
  // Advert furniture
  "job", "jobs", "role", "roles", "position", "positions", "title", "company",
  "companies", "team", "teams", "work", "working", "works", "candidate",
  "candidates", "applicant", "applicants", "hiring", "hire", "join", "joining",
  "looking", "seeking", "seek", "apply", "application", "opportunity",
  "opportunities", "overview", "description", "responsibility",
  "responsibilities", "requirement", "requirements", "qualification",
  "qualifications", "duties", "summary", "offer", "offers", "benefits",
  "salary", "compensation", "employment", "employer", "employee", "employees",
  "staff", "department", "location", "remote", "hybrid", "onsite", "office",
  "full", "part", "time", "contract", "permanent", "level", "years", "year",
  "minimum", "plus", "preferred", "required", "desirable", "ideal", "ideally",
  "equal", "diversity", "inclusive", "inclusion",
  // Praise
  "passionate", "passion", "dynamic", "innovative", "innovation", "exciting",
  "excellent", "exceptional", "strong", "highly", "skilled", "experienced",
  "experience", "experiences", "expertise", "expert", "proven", "track",
  "record", "ability", "abilities", "able", "skills", "skill", "knowledge",
  "understanding", "familiarity", "proficiency", "proficient", "competency",
  "competencies", "player", "players", "loves", "love", "enjoy", "great",
  "good", "best", "leading", "world", "class", "cutting", "edge", "fast",
  "paced", "environment", "culture", "values", "mission", "vision",
  "collaboration", "collaborative", "collaborate", "communication",
  "communicate", "interpersonal", "motivated", "detail", "oriented",
  "organizational", "problem", "solving", "thinking", "player",
  // Vague business nouns
  "business", "businesses", "client", "clients", "customer", "customers",
  "stakeholder", "stakeholders", "solution", "solutions", "service",
  "services", "product", "products", "project", "projects", "process",
  "processes", "goal", "goals", "need", "needs", "support", "supporting",
  "provide", "providing", "ensure", "ensuring", "help", "helping", "new",
  "including", "across", "within", "using", "use", "based", "related",
]);

/** Terms the job *title* contributes rank above body terms: a title is the
 *  densest sentence in the posting and the only one guaranteed to be about the
 *  work rather than about the employer. */
const TITLE_WEIGHT = 5;

/** A recognised technology outranks an ordinary distinctive word, but no longer
 *  excludes it. */
const VOCAB_WEIGHT = 3;

/**
 * Pull the terms that identify this role out of its title and description.
 * Returns a space-joined string suitable for `websearch_to_tsquery`.
 *
 * Renamed from `extractTechKeywords`: the old name described the allow-list it
 * used rather than the job it does, and the allow-list was the defect.
 */
export function extractRoleKeywords(
  jdText: string | null,
  title?: string | null,
  limit = 25,
): string {
  interface Term {
    score: number;
    count: number;
    /** From the title or a known technology: admitted on one mention. */
    privileged: boolean;
  }
  const terms = new Map<string, Term>();

  const add = (word: string, weight: number, privileged: boolean) => {
    const term = word.replace(/[.]+$/, "");
    if (term.length < 3) return;
    if (JD_BOILERPLATE.has(term)) return;
    // A bare number is a year, a headcount or a salary band — never a skill.
    if (!/[a-z]/.test(term)) return;
    const entry = terms.get(term) ?? { score: 0, count: 0, privileged: false };
    entry.score += weight;
    entry.count += 1;
    entry.privileged ||= privileged;
    terms.set(term, entry);
  };

  for (const word of title?.toLowerCase().match(/[a-z][a-z0-9+#.]*/g) ?? []) {
    add(word, TITLE_WEIGHT, true);
  }

  for (const word of jdText?.toLowerCase().match(/[a-z][a-z0-9+#.]*/g) ?? []) {
    const known = VOCAB_SET.has(word.replace(/[.]+$/, ""));
    add(word, known ? VOCAB_WEIGHT : 1, known);
  }

  for (const pattern of STRUCTURAL_PATTERNS) {
    for (const match of jdText?.match(pattern) ?? []) {
      add(match.toLowerCase(), VOCAB_WEIGHT, true);
    }
  }

  return [...terms.entries()]
    // A word the posting used once, and which is neither in the title nor a
    // recognised technology, is prose. Admitting it cost nothing under the old
    // allow-list because nothing got in at all; under an open vocabulary it is
    // most of the output — the first run of this function returned "want",
    // "after" and "stay" alongside "oracle" and "hcm". An OR query is a ranking
    // signal, so every such term is a chunk that matches for no reason.
    .filter(([, term]) => term.privileged || term.count > 1)
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term)
    // websearch_to_tsquery treats these as operators; strip so they read as terms.
    .map((term) => term.replace(/["()]/g, ""))
    .join(" ");
}

/**
 * Turn a space-separated term list into a websearch_to_tsquery *union*.
 *
 * `websearch_to_tsquery('english', 'python kafka aws')` compiles bare words to
 * `'python' & 'kafka' & 'aws'` — AND, not OR. The sparse leg guards itself with
 * `c.fts @@ websearch_to_tsquery(...)`, so handing it 25 job-description
 * keywords asked Postgres for a resume chunk containing all twenty-five. No
 * chunk has ever contained twenty-five technologies, which means the sparse leg
 * matched nothing on every draft this system has produced and the "hybrid"
 * search was dense-only. `or` between the terms is what makes it a ranking
 * instead of a filter.
 *
 * Terms are also de-duplicated, since the two lenses contribute overlapping
 * vocabulary and a repeated term only inflates the query.
 */
export function toOrQuery(terms: Iterable<string>): string {
  const seen = new Set<string>();
  for (const raw of terms) {
    for (const term of raw.toLowerCase().split(/\s+/)) {
      // `or` and `and` are operators here, and a leading `-` means NOT.
      const cleaned = term.replace(/["()]/g, "").replace(/^-+/, "");
      if (cleaned && cleaned !== "or" && cleaned !== "and") seen.add(cleaned);
    }
  }
  return [...seen].join(" or ");
}

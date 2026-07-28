"use strict";

const RULE_SOURCE_URL = "./docs/el_alamein_rules_cn_translation.md?v=20260728-126";
const IMPLEMENTATION_GUIDE_HEADING = "# 给 Codex 实现时建议抽象的数据结构";
const EXCLUDED_SECTION_IDS = new Set(["section-19", "appendix-c"]);

const OMITTED_SUBSECTIONS = new Map([
  ["section-3", new Set(["3.2 游戏图表", "3.4 游戏组件清单", "游戏回合标记"])],
  ["section-8", new Set(["8.03 堆叠中的上下位置没有意义"])],
  ["section-18", new Set(["18.4 自由设置场景", "18.5 场景变体表"])],
  ["appendix-d", new Set(["游戏扩展补充"])]
]);

const OMITTED_LINES = new Set([
  "每个场景都呈现了实际参加相应战斗的部队。游戏还提供若干可选的“假如”场景变体，用来演示历史如果发生变化，战场力量和部署可能出现怎样的不同。",
  "22 英寸 × 28 英寸的地图表示埃及境内从地中海到卡塔拉洼地之间的区域，三次阿拉曼战役均发生在该地区。",
  "建议玩家在设置游戏前，先按照类型和颜色对单位进行分类，这样可以减少准备时间。",
  "游戏回合标记在回合记录表上向前移动一格，表示新的游戏回合开始。",
  "雷区标记根据每个场景的设置表放置在地图上。"
]);

const DIGITAL_LINE_REPLACEMENTS = new Map([
  [
    "《El Alamein》基本上是一款两人游戏。游戏按照一系列“游戏回合”（Game-Turn）进行。在每个游戏回合中，双方玩家在地图上移动部队、进行战斗，并尝试达成各自目标。",
    "游戏按照一系列“游戏回合”（Game-Turn）进行。在每个游戏回合中，双方在地图上移动部队、进行战斗，并尝试达成各自目标。"
  ],
  [
    "在玩家的初始移动阶段，当前玩家可以让任意数量的单位进入道路模式。单位进入道路模式时，将道路模式标记放置在该单位上。",
    "在玩家的初始移动阶段，当前玩家可以让任意数量的单位进入道路模式。"
  ],
  [
    "所有攻击单位被消灭。攻击单位从地图上移除并放到回合记录表上。",
    "所有攻击单位被消灭。"
  ],
  [
    "所有防御单位被消灭。防御单位从地图上移除并放到回合记录表上。",
    "所有防御单位被消灭。"
  ],
  [
    "如果单位因为地形、敌方控制区、敌方单位或敌方雷区等原因无法安全撤退，则该单位被消灭并放置到回合记录表上。",
    "如果单位因为地形、敌方控制区、敌方单位或敌方雷区等原因无法安全撤退，则该单位被消灭。"
  ],
  [
    "每个场景都有自己的设置表，并且有自己的胜利条件。",
    "每个场景都有自己的胜利条件。"
  ],
  [
    "战斗结果表见地图表格。战斗结果用如下符号表示：",
    "战斗结果表见附录 A。战斗结果用如下符号表示："
  ]
]);

const DISPLAY_TITLES = new Map([
  ["3.0 游戏组件", "3.0 地图、单位与状态"]
]);

const SECTION_IDS = new Map([
  ["1.0 引言", "section-1"],
  ["2.0 游戏总体流程", "section-2"],
  ["3.0 游戏组件", "section-3"],
  ["4.0 游戏顺序", "section-4"],
  ["5.0 移动", "section-5"],
  ["6.0 道路模式移动", "section-6"],
  ["7.0 控制区", "section-7"],
  ["8.0 堆叠", "section-8"],
  ["9.0 战斗", "section-9"],
  ["10.0 战斗结果表", "section-10"],
  ["11.0 雷区", "section-11"],
  ["12.0 工兵单位", "section-12"],
  ["13.0 补给", "section-13"],
  ["14.0 孤立", "section-14"],
  ["15.0 道路", "section-15"],
  ["16.0 地图边缘", "section-16"],
  ["17.0 胜利条件", "section-17"],
  ["18.0 场景", "section-18"],
  ["19.0 设计人员", "section-19"],
  ["附录 A：战斗结果表翻译", "appendix-a"],
  ["附录 B：地形效果表翻译", "appendix-b"],
  ["附录 C：场景变体表翻译", "appendix-c"],
  ["附录 D：1973 年综合勘误翻译", "appendix-d"]
]);

function splitSectionTitle(title) {
  const match = title.match(/^(\d+(?:\.\d+)?|附录\s+[A-D])(?:[：.]?\s*)(.*)$/);
  if (!match) return { number: "RULE", title };
  return { number: match[1], title: match[2] || title };
}

function filterSectionLines(sourceSection) {
  const omittedHeadings = OMITTED_SUBSECTIONS.get(sourceSection.id) || new Set();
  const filtered = [];
  let skippedHeadingLevel = 0;

  sourceSection.lines.forEach((sourceLine) => {
    const line = sourceLine.trim();
    const heading = sourceLine.match(/^(#{2,4})\s+(.+)$/);
    const headingLevel = heading ? heading[1].length : 0;

    if (skippedHeadingLevel && heading && headingLevel <= skippedHeadingLevel) {
      skippedHeadingLevel = 0;
    }
    if (skippedHeadingLevel) return;
    if (heading && omittedHeadings.has(heading[2])) {
      skippedHeadingLevel = headingLevel;
      return;
    }
    if (OMITTED_LINES.has(line)) return;
    filtered.push(DIGITAL_LINE_REPLACEMENTS.get(line) || sourceLine);
  });
  return filtered;
}

function appendInlineText(element, source) {
  const fragments = String(source).split(/(`[^`]*`)/g);
  fragments.forEach((fragment) => {
    if (fragment.startsWith("`") && fragment.endsWith("`") && fragment.length >= 2) {
      const code = document.createElement("code");
      code.textContent = fragment.slice(1, -1);
      element.append(code);
      return;
    }
    element.append(document.createTextNode(fragment));
  });
}

function createHeading(level, text) {
  const heading = document.createElement(level === 2 ? "h3" : level === 3 ? "h4" : "h5");
  appendInlineText(heading, text);
  return heading;
}

function createParagraph(lines) {
  const paragraph = document.createElement("p");
  lines.forEach((line, index) => {
    const hardBreak = /\s{2}$/.test(line);
    appendInlineText(paragraph, line.trimEnd());
    if (index < lines.length - 1) paragraph.append(hardBreak ? document.createElement("br") : " ");
  });
  return paragraph;
}

function parseTable(lines) {
  const rows = lines.map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
  if (rows.length > 1 && rows[1].every((cell) => /^:?-{3,}:?$/.test(cell))) rows.splice(1, 1);

  const wrapper = document.createElement("div");
  wrapper.className = "rules-markdown-table-wrap";
  const table = document.createElement("table");
  table.className = "rules-markdown-table";

  rows.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    row.forEach((cell) => {
      const element = document.createElement(rowIndex === 0 ? "th" : "td");
      appendInlineText(element, cell);
      tr.append(element);
    });
    table.append(tr);
  });
  wrapper.append(table);
  return wrapper;
}

function createCombatResultLegend() {
  const guide = document.createElement("section");
  guide.className = "crt-result-guide";
  guide.setAttribute("aria-label", "战斗结果代码说明");

  const heading = document.createElement("div");
  heading.className = "crt-result-guide-head";
  const title = document.createElement("h3");
  title.textContent = "结果代码怎么读";
  const summary = document.createElement("p");
  summary.textContent = "先看字母确定承受结果的一方，再看数字或 e 判断具体结果。";
  heading.append(title, summary);
  guide.append(heading);

  const rows = document.createElement("div");
  rows.className = "crt-result-rows";
  [
    { code: "A1–A3", tone: "attacker", title: "攻击方撤退", text: "A 代表攻击方，数字代表必须撤退的格数。例如 A2 表示所有攻击单位撤退 2 格。" },
    { code: "D1–D3", tone: "defender", title: "防御方撤退", text: "D 代表防御方，数字代表必须撤退的格数。例如 D1 表示所有防御单位撤退 1 格。" },
    { code: "Ae", tone: "eliminated", title: "攻击方全部消灭", text: "e 表示全部消灭。Ae 表示参加这次战斗的所有攻击单位都被消灭。" },
    { code: "De", tone: "eliminated", title: "防御方全部消灭", text: "De 表示被攻击格中的所有防御单位都被消灭。" },
    { code: "Ex", tone: "exchange", title: "交换结果", text: "防御单位全部被消灭；攻击方也必须选择己方单位损失，其正面战斗强度总和至少等于被消灭防御单位的正面战斗强度总和。计算时不计地形、雷区、补给等修正。" }
  ].forEach((item) => {
    const row = document.createElement("div");
    row.className = `crt-result-row ${item.tone}`;
    const code = document.createElement("strong");
    code.textContent = item.code;
    const copy = document.createElement("div");
    const rowTitle = document.createElement("b");
    rowTitle.textContent = item.title;
    const text = document.createElement("p");
    text.textContent = item.text;
    copy.append(rowTitle, text);
    row.append(code, copy);
    rows.append(row);
  });
  guide.append(rows);

  const example = document.createElement("p");
  example.className = "crt-result-example";
  const label = document.createElement("b");
  label.textContent = "查表示例";
  example.append(label, document.createTextNode("攻击比值为 2:1、骰点为 3，交叉格结果是 A1，因此攻击方撤退 1 格。"));
  guide.append(example);
  return guide;
}

function renderSectionBody(section, lines) {
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim() || /^---+$/.test(line.trim())) {
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{2,4})\s+(.+)$/);
    if (headingMatch) {
      section.append(createHeading(headingMatch[1].length, headingMatch[2]));
      index += 1;
      continue;
    }

    if (line.startsWith("> ")) {
      const quoteLines = [];
      while (index < lines.length && lines[index].startsWith("> ")) {
        quoteLines.push(lines[index].slice(2));
        index += 1;
      }
      const quote = document.createElement("blockquote");
      quote.append(createParagraph(quoteLines));
      section.append(quote);
      continue;
    }

    if (/^\|.*\|\s*$/.test(line.trim())) {
      const tableLines = [];
      while (index < lines.length && /^\|.*\|\s*$/.test(lines[index].trim())) {
        tableLines.push(lines[index]);
        index += 1;
      }
      if (section.id === "appendix-a" && !section.querySelector(".crt-result-guide")) {
        section.append(createCombatResultLegend());
      }
      section.append(parseTable(tableLines));
      continue;
    }

    const listMatch = line.match(/^(\s*)(-|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2]);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const itemMatch = lines[index].match(/^(\s*)(-|\d+\.)\s+(.+)$/);
        if (!itemMatch || /\d+\./.test(itemMatch[2]) !== ordered) break;
        const item = document.createElement("li");
        appendInlineText(item, itemMatch[3]);
        list.append(item);
        index += 1;
      }
      section.append(list);
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length) {
      const candidate = lines[index];
      if (!candidate.trim()) break;
      if (/^(#{2,4})\s+/.test(candidate) || candidate.startsWith("> ") || /^\|.*\|\s*$/.test(candidate.trim()) || /^(\s*)(-|\d+\.)\s+/.test(candidate) || /^---+$/.test(candidate.trim())) break;
      paragraphLines.push(candidate);
      index += 1;
    }
    if (paragraphLines.length) {
      section.append(createParagraph(paragraphLines));
    } else {
      index += 1;
    }
  }
}

function parseRuleSections(source) {
  const formalSource = source.split(IMPLEMENTATION_GUIDE_HEADING)[0].trim();
  const lines = formalSource.split(/\r?\n/);
  const sections = [];
  let current = null;

  lines.forEach((line) => {
    const heading = line.match(/^#\s+(.+)$/);
    if (heading && SECTION_IDS.has(heading[1])) {
      current = { title: heading[1], id: SECTION_IDS.get(heading[1]), lines: [] };
      sections.push(current);
      return;
    }
    if (current) current.lines.push(line);
  });
  return sections
    .filter((section) => !EXCLUDED_SECTION_IDS.has(section.id))
    .map((section) => ({ ...section, lines: filterSectionLines(section) }));
}

function renderRulebook(source) {
  const content = document.getElementById("rulesContent");
  const toc = document.getElementById("rulesToc");
  const sections = parseRuleSections(source);
  content.replaceChildren();
  toc.querySelector(".rules-loading-line")?.remove();

  sections.forEach((sourceSection, index) => {
    const section = document.createElement("section");
    section.id = sourceSection.id;
    section.className = `rules-section${index === 0 ? " rules-section-feature" : ""}`;

    const displayTitle = DISPLAY_TITLES.get(sourceSection.title) || sourceSection.title;
    const title = splitSectionTitle(displayTitle);
    const head = document.createElement("div");
    head.className = "rules-section-head";
    const number = document.createElement("span");
    number.textContent = title.number;
    const heading = document.createElement("h2");
    heading.textContent = title.title;
    head.append(number, heading);
    section.append(head);
    renderSectionBody(section, sourceSection.lines);
    content.append(section);

    const link = document.createElement("a");
    link.href = `#${sourceSection.id}`;
    const linkNumber = document.createElement("span");
    linkNumber.textContent = title.number;
    const linkTitle = document.createElement("b");
    linkTitle.textContent = title.title;
    link.append(linkNumber, linkTitle);
    toc.append(link);
  });

  document.getElementById("ruleSourceStatus").textContent = "已载入游戏规则：1.0–18.0 与附录 A / B / D";
}

function showRuleSourceError(error) {
  document.getElementById("ruleSourceStatus").textContent = `规则原文载入失败：${error.message}`;
  const content = document.getElementById("rulesContent");
  content.replaceChildren();
  const section = document.createElement("section");
  section.className = "rules-section rules-source-error";
  const heading = document.createElement("h2");
  heading.textContent = "无法显示规则原文";
  const message = document.createElement("p");
  message.textContent = "请通过本项目的本地网页服务打开规则书，或直接下载规则原文查看。";
  section.append(heading, message);
  content.append(section);
}

fetch(RULE_SOURCE_URL, { cache: "no-store" })
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  })
  .then(renderRulebook)
  .catch(showRuleSourceError);

(function () {
  "use strict";

  var PAGE_SIZE = 20;
  var indexPages = [];
  var currentMatches = [];
  var currentPage = 1;
  var showingAll = false;
  var searchInput;
  var competitionSelect;
  var yearSelect;
  var clearButton;
  var status;
  var resultsList;
  var paginationBars = [];
  var pageStatuses = [];
  var previousButtons = [];
  var nextButtons = [];
  var showAllButton;
  var debounceTimer;
  var CLUB_PATTERN = /(Melbourne Brewers|Merri Mashers|Westgate Brewers|Bayside Brewers|Yarra Valley Brewers|Macedon Ranges Brew Club|Corio Bay Brewers|Canberra Brewers|West Coast Brewers|Hills Brewers Guild|Way Out West|THursty Brewers|Worthogs|Independent|No Club|Westgate|Bayside|Melbourne|Merri Mashers|Yarra Valley|GCB|\b(?:VIC|NSW|QLD|SA|WA|TAS|ACT|NT|WG|WH|MB|BS|MM|IBU|ESB|CB|SAAZ|AABV)\b)/i;

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("en-AU")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function addOptions(select, values) {
    values.forEach(function (value) {
      var option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(value);
      select.appendChild(option);
    });
  }

  function splitClub(value) {
    var match = CLUB_PATTERN.exec(value);
    if (!match) return null;
    return {
      after: value.slice(match.index + match[0].length).trim(),
      before: value.slice(0, match.index).trim(),
      club: canonicalClub(match[0].trim())
    };
  }

  function canonicalClub(value) {
    var aliases = {
      "bayside": "Bayside Brewers",
      "bs": "Bayside Brewers",
      "gcb": "Geelong Craft Brewers",
      "mb": "Melbourne Brewers",
      "melbourne": "Melbourne Brewers",
      "mm": "Merri Mashers",
      "wg": "Westgate Brewers",
      "westgate": "Westgate Brewers",
      "wh": "Worthogs"
    };
    return aliases[value.toLocaleLowerCase("en-AU")] || value;
  }

  function formatPlace(value) {
    var token = String(value || "").replace(/\*/g, "").trim();
    if (!token) return "";
    if (/^=?\d+(?:st|nd|rd|th)$/i.test(token)) return token;
    var match = token.match(/^(=)?(\d+)$/);
    if (!match) return token;
    var number = Number(match[2]);
    var tens = number % 100;
    var suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[number % 10] || "th");
    return (match[1] || "") + number + suffix;
  }

  function cleanStyle(value) {
    var style = String(value || "")
      .replace(/^[-,:|\s]+|[-,:|\s]+$/g, "")
      .replace(/^\d+(?:\.\d+)?[.:]?\s+(?=[a-z])/i, "")
      .replace(/\s*\[BJCP\s+[^\]]+\]\s*$/i, "")
      .replace(/\s+#?\d+\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!style || style.length > 100 || /^\d+(?:\.\d+)?\*?$/.test(style)) return "";
    return style;
  }

  function styleAfterScore(value) {
    return cleanStyle(String(value || "")
      .replace(/^[-,:|\s]+/, "")
      .replace(/^(?:\d+(?:\.\d+)?\.?\s*(?:pts?)?[-,:|\s]+)+/i, "")
      .replace(/\s+#?\d+\s*$/, ""));
  }

  function trimBrewingDetails(value) {
    return value
      .replace(/\s+(?:wyeast|wy\s?\d+|wlp\s?\d+|saf\S*|us-?05|s-?04|nottingham|coopers)\b.*$/i, "")
      .replace(/\s+1\.\d{3}(?:\s+1\.\d{3})?.*$/, "")
      .trim();
  }

  function expandNameMatch(line, match) {
    if (!match) return null;
    var start = match.index;
    var end = start + match[0].length;
    var nameCharacter = /[A-Za-zÀ-ÖØ-öø-ÿ'’-]/;
    while (start > 0 && nameCharacter.test(line.charAt(start - 1))) start -= 1;
    while (end < line.length && nameCharacter.test(line.charAt(end))) end += 1;
    return { 0: line.slice(start, end), index: start };
  }

  function queryNameMatch(line, rawQuery) {
    var words = rawQuery.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    var escapedWords = words.map(function (word) {
      return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
    var directMatch = new RegExp(escapedWords.join("\\s+"), "i").exec(line);
    if (directMatch || escapedWords.length < 2) return expandNameMatch(line, directMatch);

    // Older summaries commonly use "Surname, First" even when visitors enter
    // the natural "First Surname" form.
    var reversedPattern = escapedWords[escapedWords.length - 1]
      + "\\s*,?\\s*"
      + escapedWords.slice(0, -1).join("\\s+");
    return expandNameMatch(line, new RegExp(reversedPattern, "i").exec(line));
  }

  function categoryStyle(page, lineIndex) {
    for (var index = lineIndex - 1; index >= Math.max(0, lineIndex - 12); index -= 1) {
      var line = page._lines[index].raw;
      if (/number of entries/i.test(line) && !/entry no|bottle cap/i.test(line)) {
        return cleanStyle(line.replace(/number of entries.*$/i, ""));
      }
    }
    return "";
  }

  function headingStyle(page, lineIndex) {
    for (var index = lineIndex - 1; index >= Math.max(0, lineIndex - 15); index -= 1) {
      var raw = page._lines[index].raw.trim();
      if (!raw || /^(?:=?\d+|1st|2nd|3rd)\b/i.test(raw)) continue;
      if (/\bresults?\b|\bpage\s+\d+\b|\b(?:place|entrant|brewer|entry|score|club)\b/i.test(raw)) {
        continue;
      }
      return cleanStyle(raw.replace(/\s+category\s*$/i, ""));
    }
    return "";
  }

  function extractFields(page, match, rawQuery) {
    var line = match.lineIndex >= 0 ? page._lines[match.lineIndex].raw : "";
    var mayWrapBeforeClub = page.layout === "place_name_entry_style_club_score"
      || page.layout === "place_name_style_club_score";
    if (match.lineIndex >= 0 && mayWrapBeforeClub && !CLUB_PATTERN.test(line) && line.length < 260) {
      for (var continuation = match.lineIndex + 1;
        continuation < Math.min(page._lines.length, match.lineIndex + 3);
        continuation += 1) {
        var nextLine = page._lines[continuation].raw;
        if (/^(?:=?\d+|1st|2nd|3rd)\b/i.test(nextLine.trim())) break;
        line += " " + nextLine;
        if (CLUB_PATTERN.test(line)) break;
      }
    }
    var nameMatch = queryNameMatch(line, rawQuery);
    var brewer = nameMatch ? nameMatch[0] : rawQuery.trim();
    var before = nameMatch ? line.slice(0, nameMatch.index).trim() : "";
    var after = nameMatch ? line.slice(nameMatch.index + nameMatch[0].length).trim() : "";
    var layout = page.layout || "unknown";
    var place = "";
    var style = "";
    var club = "";
    var clubParts;

    var firstToken = line.trim().match(/^(=?\d+(?:st|nd|rd|th)?)(?=[\s.)-])/i);
    if (firstToken) {
      place = formatPlace(firstToken[1]);
    } else if (/_(?:score_)?place$/.test(layout)) {
      var lastToken = after.match(/(=?\d+(?:st|nd|rd|th)?\*?)\s*$/i);
      if (lastToken) place = formatPlace(lastToken[1]);
    }

    switch (layout) {
      case "place_name_entry_style_club_score":
        clubParts = splitClub(after);
        if (clubParts) {
          club = clubParts.club;
          style = cleanStyle(clubParts.before.replace(/^#?\d+\s+/, ""));
        }
        break;
      case "place_name_style_entry_score":
        var bjcpStyle = after.match(/^(.+?\[BJCP\s+[^\]]+\])/i);
        if (bjcpStyle) style = cleanStyle(bjcpStyle[1]);
        break;
      case "place_name_style_club_score":
      case "place_entry_judging_name_style_club_score":
      case "place_name_style_club_entry_score":
        clubParts = splitClub(after);
        if (clubParts) {
          club = clubParts.club;
          style = cleanStyle(clubParts.before);
        } else if (layout === "place_name_style_club_entry_score") {
          style = cleanStyle(after.replace(/(?:\s+\d+(?:\.\d+)?){5,}\s*$/, ""));
        } else {
          style = cleanStyle(after.replace(/\s+\d+(?:\.\d+)?\s*$/, ""));
        }
        break;
      case "place_entry_style_name_score":
        style = cleanStyle(before.replace(
          /^=?\d+\s*(?:st|nd|rd|th)?\*?\s+\d+\s+/i,
          ""
        ).replace(/^[A-Z](?=[A-Z][a-z])/, ""));
        break;
      case "entry_place_style_name_club_score":
        var embeddedPlace = before.match(/^\d+\s+(=?\d+\s*(?:st|nd|rd|th)?)/i);
        if (embeddedPlace) place = formatPlace(embeddedPlace[1].replace(/\s+/g, ""));
        style = cleanStyle(before.replace(
          /^\d+\s+=?\d+\s*(?:st|nd|rd|th)?\*?\s+/i,
          ""
        ));
        clubParts = splitClub(after);
        if (clubParts) club = clubParts.club;
        break;
      case "place_entry_style_name_club_score":
        style = cleanStyle(before.replace(
          /^=?\d+\s*(?:st|nd|rd|th)?\*?\s+\d+\s+/i,
          ""
        ));
        clubParts = splitClub(after);
        if (clubParts) club = clubParts.club;
        break;
      case "style_entry_name_club_score":
        clubParts = splitClub(after);
        if (clubParts) club = clubParts.club;
        style = cleanStyle(before.replace(/^\d+(?:\.\d+)?\s+/, "").replace(/\s+#?\d+\s*$/, ""));
        break;
      case "place_score_style_name_club":
        clubParts = splitClub(after);
        if (clubParts) club = clubParts.club;
        style = cleanStyle(before.replace(/^=?\d+(?:st|nd|rd|th)?\*?\s+\d+(?:\.\d+)?\s+/i, ""));
        break;
      case "place_style_name_club_score":
        clubParts = splitClub(after);
        if (clubParts) club = clubParts.club;
        style = cleanStyle(before.replace(/^=?\d+\s*(?:st|nd|rd|th)?\*?\s+/i, ""));
        break;
      case "entry_name_club_style_score":
        clubParts = splitClub(after);
        if (clubParts) {
          club = clubParts.club;
          style = cleanStyle(clubParts.after.replace(/\s+\d+(?:\.\d+)?\*?\s*$/, ""));
        }
        break;
      case "place_name_club_score_style":
        clubParts = splitClub(after);
        if (clubParts) {
          club = clubParts.club;
          style = cleanStyle(clubParts.after.replace(/^\d+(?:\.\d+)?\*?\s+/, ""));
        }
        break;
      case "service_entry_name_club_style_score_place":
        clubParts = splitClub(after);
        if (clubParts) {
          club = clubParts.club;
          style = cleanStyle(clubParts.after.replace(/\s+\d+(?:\.\d+)?\s+\d+(?:st|nd|rd|th)?\s*$/i, ""));
        }
        break;
      case "entry_name_club_score_place":
        clubParts = splitClub(after);
        if (clubParts) club = clubParts.club;
        style = categoryStyle(page, match.lineIndex);
        break;
      case "place_name_club_score_style_extra":
      case "place_name_state_club_score_style_extra":
        clubParts = splitClub(after);
        if (clubParts) {
          club = clubParts.club;
          var secondClubParts = splitClub(clubParts.after);
          if (secondClubParts && !secondClubParts.before) {
            club = secondClubParts.club;
            style = secondClubParts.after
              ? styleAfterScore(trimBrewingDetails(secondClubParts.after))
              : cleanStyle(clubParts.before.replace(/^\d+(?:\.\d+)?\*?\s+/, ""));
          } else if (clubParts.after) {
            style = styleAfterScore(trimBrewingDetails(clubParts.after));
          } else {
            style = cleanStyle(clubParts.before.replace(/\s+\d+(?:\.\d+)?\*?\s*$/, ""));
          }
        }
        break;
      case "place_name_score_club_style_entry":
        clubParts = splitClub(after);
        if (clubParts) { club = clubParts.club; style = cleanStyle(clubParts.after); }
        break;
      case "name_entry_style_state_score":
        style = cleanStyle(after
          .replace(/^#?\d+\s+/, "")
          .replace(/\s+(?:VIC|NSW|QLD|SA|WA|TAS|ACT|NT)\s+\d+(?:\.\d+)?\*?\s*$/i, ""));
        break;
      case "place_name_club_heading_style":
        var rowWithoutPlace = line.replace(/^=?\d+(?:st|nd|rd|th)?\*?\s+/i, "");
        clubParts = splitClub(rowWithoutPlace);
        if (clubParts) {
          brewer = clubParts.before.replace(/\s+/g, " ").trim();
          club = clubParts.club;
        }
        style = headingStyle(page, match.lineIndex);
        break;
      default:
        clubParts = splitClub(after);
        if (clubParts) {
          club = clubParts.club;
          style = cleanStyle(clubParts.before.replace(/^#?\d+\s+/, ""));
          if (!style) style = styleAfterScore(clubParts.after);
        }
    }

    return { brewer: brewer, club: club, place: place, raw: line, style: style };
  }

  function contextScore(page, lineIndex) {
    var context = page._lines
      .slice(Math.max(0, lineIndex - 2), Math.min(page._lines.length, lineIndex + 3))
      .map(function (candidate) { return candidate.search; })
      .join(" ");
    var line = page._lines[lineIndex];
    var score = 0;
    if (/^(?:=?\d+|1st|2nd|3rd|winner|runner)/.test(line.search)) score += 700;
    if (/\b(place|entrant|brewer|style|club|score|entry)\b/.test(context)) score += 320;
    if (/\b(judges?|stewards?|committee|organiser|organizer)\b/.test(context)) score -= 900;
    if (/\bchampion brewer|\bchampion beer|\bbeer of show\b|\bbest novice\b|\bclub of show/.test(context)) score -= 2600;
    if (/\bplace brewer 1st 2nd 3rd score club\b/.test(context)) score -= 2600;
    if (/\bdata entry\b/.test(context)) score -= 500;
    return score;
  }

  function isLikelyResultRow(page, lineIndex) {
    var line = page._lines[lineIndex];
    var raw = line.raw.trim();
    var layout = page.layout || "unknown";
    if (!raw || raw.length > 450 || /\bjudges?\b|\bstewards?\b/i.test(raw)) return false;
    if (layout === "place_name_style_entry_score") {
      return !/^place\s+first\s+name\b/i.test(raw);
    }
    if (/^place_/.test(layout)) return /^(?:=?\d+|1st|2nd|3rd)\b/i.test(raw);
    if (layout === "style_entry_name_club_score") return /^\d+(?:\.\d+)?\s+/.test(raw);
    if (/^(?:entry|service)_/.test(layout)) return /^\d+\s+/.test(raw);
    if (layout === "name_entry_style_state_score") {
      return /\s\d+\s+.+\s(?:VIC|NSW|QLD|SA|WA|TAS|ACT|NT)\s+\d+(?:\.\d+)?\*?\s*$/i.test(raw);
    }
    return /^(?:=?\d+|1st|2nd|3rd)\b/i.test(raw);
  }

  function matchPageRows(page, query, terms) {
    if (!terms.every(function (term) { return page._search.indexOf(term) >= 0; })) {
      return [];
    }

    var rows = [];
    page._lines.forEach(function (line, lineIndex) {
      if (!terms.every(function (term) { return line.search.indexOf(term) >= 0; })) return;
      if (!isLikelyResultRow(page, lineIndex)) return;
      var rowScore = (line.search.indexOf(query) >= 0 ? 1000 : 0) + contextScore(page, lineIndex);
      if (rowScore < 0) return;
      rows.push({ lineIndex: lineIndex, offset: line.offset, score: rowScore });
    });

    if (!rows.length && page._lines.length <= 3
      && !/\bchampion brewer\b.*\bplace brewer 1st 2nd 3rd\b/.test(page._search)) {
      var phraseIndex = page._search.indexOf(query);
      rows.push({ lineIndex: -1, offset: phraseIndex, score: 100 });
    }
    return rows;
  }

  function addResultField(list, label, value) {
    if (!value) return;
    var group = document.createElement("div");
    var term = document.createElement("dt");
    var description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    group.appendChild(term);
    group.appendChild(description);
    list.appendChild(group);
  }

  function createResult(match, rawQuery) {
    var page = match.page;
    var fields = extractFields(page, match, rawQuery);
    var item = document.createElement("li");
    item.className = "results-search-result";

    var heading = document.createElement("h3");
    heading.textContent = fields.brewer;

    var details = document.createElement("p");
    details.className = "results-search-result__details";
    var link = document.createElement("a");
    link.href = page.path + "#page=" + page.page;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = page.competition + " " + page.year + " · " + page.kind + " · page " + page.page;
    details.appendChild(link);

    var fieldList = document.createElement("dl");
    fieldList.className = "results-search-result__fields";
    addResultField(fieldList, "Place", fields.place || "Not stated");
    addResultField(fieldList, "Style", fields.style || "Not identified");
    addResultField(fieldList, "Club", fields.club);

    var sourceDetails;
    if (fields.raw && fields.raw.length <= 500) {
      sourceDetails = document.createElement("details");
      sourceDetails.className = "results-search-result__source";
      var summary = document.createElement("summary");
      summary.textContent = "View extracted source row";
      var source = document.createElement("p");
      source.textContent = fields.raw;
      sourceDetails.appendChild(summary);
      sourceDetails.appendChild(source);
    }

    var filename = document.createElement("p");
    filename.className = "results-search-result__filename";
    filename.textContent = page.filename;

    item.appendChild(heading);
    item.appendChild(details);
    item.appendChild(fieldList);
    if (sourceDetails) item.appendChild(sourceDetails);
    item.appendChild(filename);
    return item;
  }

  function scrollToResults() {
    var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    paginationBars[0].scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  }

  function renderMatches(rawQuery, shouldScroll) {
    resultsList.replaceChildren();

    if (!currentMatches.length) {
      resultsList.hidden = true;
      paginationBars.forEach(function (bar) { bar.hidden = true; });
      return;
    }

    var totalPages = Math.ceil(currentMatches.length / PAGE_SIZE);
    var start = showingAll ? 0 : (currentPage - 1) * PAGE_SIZE;
    var end = showingAll ? currentMatches.length : Math.min(start + PAGE_SIZE, currentMatches.length);

    currentMatches.slice(start, end).forEach(function (match) {
      resultsList.appendChild(createResult(match, rawQuery));
    });

    resultsList.hidden = false;
    paginationBars.forEach(function (bar) { bar.hidden = currentMatches.length <= PAGE_SIZE; });
    previousButtons.forEach(function (button) { button.disabled = showingAll || currentPage === 1; });
    nextButtons.forEach(function (button) { button.disabled = showingAll || currentPage >= totalPages; });
    showAllButton.textContent = showingAll ? "Show 20 per page" : "Show all";
    pageStatuses.forEach(function (item) {
      item.textContent = showingAll ? "All results" : "Page " + currentPage + " of " + totalPages;
    });

    status.textContent = showingAll
      ? "Showing all " + currentMatches.length + " matching results."
      : "Showing results " + (start + 1) + "-" + end + " of " + currentMatches.length + ".";

    if (shouldScroll) scrollToResults();
  }

  function runSearch() {
    window.clearTimeout(debounceTimer);

    var rawQuery = searchInput.value.trim();
    var query = normalize(rawQuery);
    var terms = query.split(" ").filter(Boolean);
    var competition = competitionSelect.value;
    var year = yearSelect.value;

    resultsList.replaceChildren();
    resultsList.hidden = true;
    paginationBars.forEach(function (bar) { bar.hidden = true; });
    currentMatches = [];
    currentPage = 1;
    showingAll = false;

    if (query.length < 2) {
      status.textContent = "Enter at least two characters of a brewer's name.";
      return;
    }

    var matches = [];
    indexPages.forEach(function (page) {
      if (competition && page.competition !== competition) return;
      if (year && String(page.year) !== year) return;
      matchPageRows(page, query, terms).forEach(function (match) {
        matches.push({
          lineIndex: match.lineIndex,
          offset: match.offset,
          page: page,
          score: match.score
        });
      });
    });

    matches.sort(function (a, b) {
      return b.page.year - a.page.year
        || a.page.competition.localeCompare(b.page.competition)
        || a.page.page - b.page.page
        || a.lineIndex - b.lineIndex
        || b.score - a.score;
    });

    if (!matches.length) {
      status.textContent = "No matching results found. Try part of the name or check the spelling used in the PDF.";
      return;
    }

    currentMatches = matches;
    renderMatches(rawQuery, false);
  }

  function scheduleSearch() {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(runSearch, 90);
  }

  function enableSearch(index) {
    indexPages = index.pages.map(function (page) {
      page._search = normalize(page.text);
      var offset = 0;
      page._lines = page.text.split("\n").map(function (line) {
        var searchableLine = { offset: offset, raw: line, search: normalize(line) };
        offset += line.length + 1;
        return searchableLine;
      });
      return page;
    });

    var competitions = Array.from(new Set(indexPages.map(function (page) { return page.competition; }))).sort();
    var years = Array.from(new Set(indexPages.map(function (page) { return page.year; })))
      .filter(Boolean)
      .sort(function (a, b) { return b - a; });

    addOptions(competitionSelect, competitions);
    addOptions(yearSelect, years);
    [searchInput, competitionSelect, yearSelect, clearButton].forEach(function (control) {
      control.disabled = false;
    });

    status.textContent = "Searches " + index.meta.searchableDocuments + " of " + index.meta.documents
      + " linked result PDFs. Enter at least two characters of a brewer's name.";
  }

  function showLoadError() {
    status.textContent = "The search index could not be loaded. The full PDF archive remains available below.";
    status.classList.add("results-search-status--error");
  }

  document.addEventListener("DOMContentLoaded", function () {
    searchInput = document.getElementById("brewer-search");
    competitionSelect = document.getElementById("brewer-search-competition");
    yearSelect = document.getElementById("brewer-search-year");
    clearButton = document.getElementById("brewer-search-clear");
    status = document.getElementById("brewer-search-status");
    resultsList = document.getElementById("brewer-search-results");
    paginationBars = Array.from(document.querySelectorAll("[data-results-pagination]"));
    pageStatuses = Array.from(document.querySelectorAll("[data-results-page-status]"));
    previousButtons = Array.from(document.querySelectorAll("[data-results-previous]"));
    nextButtons = Array.from(document.querySelectorAll("[data-results-next]"));
    showAllButton = document.getElementById("brewer-search-show-all");

    if (!searchInput || !competitionSelect || !yearSelect || !clearButton || !status || !resultsList
      || paginationBars.length !== 2 || pageStatuses.length !== 2
      || previousButtons.length !== 2 || nextButtons.length !== 2 || !showAllButton) return;

    searchInput.addEventListener("input", scheduleSearch);
    competitionSelect.addEventListener("change", runSearch);
    yearSelect.addEventListener("change", runSearch);
    document.getElementById("results-search-form").addEventListener("submit", function (event) {
      event.preventDefault();
      runSearch();
    });
    document.getElementById("results-search-form").addEventListener("reset", function () {
      window.setTimeout(runSearch, 0);
    });
    previousButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        if (currentPage <= 1) return;
        currentPage -= 1;
        renderMatches(searchInput.value.trim(), true);
      });
    });
    nextButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        if (currentPage >= Math.ceil(currentMatches.length / PAGE_SIZE)) return;
        currentPage += 1;
        renderMatches(searchInput.value.trim(), true);
      });
    });
    showAllButton.addEventListener("click", function () {
      showingAll = !showingAll;
      currentPage = 1;
      renderMatches(searchInput.value.trim(), true);
    });

    if (window.VICBREW_RESULTS_SEARCH_INDEX) {
      var bundledIndex = window.VICBREW_RESULTS_SEARCH_INDEX;
      window.VICBREW_RESULTS_SEARCH_INDEX = null;
      enableSearch(bundledIndex);
      return;
    }

    window.fetch("./results-search-index.json", { credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) throw new Error("Search index returned " + response.status);
        return response.json();
      })
      .then(enableSearch)
      .catch(showLoadError);
  });
}());

export function isValidTopicName(topic: string): boolean {
  return topic.length > 0 && !topic.includes("\0") && !topic.includes("+") && !topic.includes("#");
}

export function isValidTopicFilter(filter: string): boolean {
  if (!filter || filter.includes("\0")) return false;
  return filter.split("/").every((level, index, levels) => {
    if (level === "+") return true;
    if (level === "#") return index === levels.length - 1;
    return !level.includes("+") && !level.includes("#");
  });
}

export function topicMatchesFilter(filter: string, topic: string): boolean {
  if (!isValidTopicFilter(filter) || !isValidTopicName(topic)) return false;
  if (topic.startsWith("$") && !filter.startsWith("$")) return false;
  const filters = filter.split("/");
  const topics = topic.split("/");
  for (let index = 0; index < filters.length; index += 1) {
    const part = filters[index];
    if (part === "#") return true;
    if (part !== "+" && part !== topics[index]) return false;
    if (topics[index] === undefined) return false;
  }
  return filters.length === topics.length;
}

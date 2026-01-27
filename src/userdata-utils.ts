/** Generates a shell command to write content to a file */
export const writeFile = (path: string, content: string, executable = false) => {
  if (!content.endsWith("\n")) {
    content += "\n"
  }
  var ret = `cat << 'EOF' > ${path}\n${content}EOF`
  if (executable) {
    ret += `\nchmod +x ${path}`
  }
  return ret
}

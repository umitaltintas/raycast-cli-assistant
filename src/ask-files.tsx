import { getSelectedFinderItems, Icon, LaunchProps, List } from "@raycast/api";
import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { useEffect, useState } from "react";
import { AnswerView } from "./components/AnswerView";
import { defaultOptions } from "./lib/options";
import { FILE_MANAGER, IS_WINDOWS } from "./lib/platform";
import { askAboutFilesPrompt } from "./lib/prompts";

interface Selection {
  paths: string[];
  // Folders the model may read: selected folders and the folders of selected
  // files.
  dirs: string[];
}

async function readFinderSelection(): Promise<Selection> {
  let paths: string[] = [];
  try {
    paths = (await getSelectedFinderItems()).map((i) => i.path);
  } catch {
    // Finder/File Explorer is not frontmost or nothing is selected
  }
  const dirs = paths.map((p) => {
    try {
      return statSync(p).isDirectory() ? p : dirname(p);
    } catch {
      return dirname(p);
    }
  });
  return { paths, dirs: [...new Set(dirs)] };
}

export default function Command(
  props: LaunchProps<{ arguments: Arguments.AskFiles }>,
) {
  const [selection, setSelection] = useState<Selection>();
  useEffect(() => {
    readFinderSelection().then(setSelection);
  }, []);

  if (!selection) return <List isLoading />;
  if (!selection.paths.length) {
    return (
      <List>
        <List.EmptyView
          icon={IS_WINDOWS ? Icon.HardDrive : Icon.Finder}
          title={`Nothing Selected in ${FILE_MANAGER}`}
          description={`Select files or folders in ${FILE_MANAGER}, then run this command.`}
        />
      </List>
    );
  }

  const question =
    props.arguments.question?.trim() || "What is this, in short?";
  const names = selection.paths.map((p) => basename(p));
  const shown =
    names.length > 3 ? `${names.slice(0, 3).join(", ")}…` : names.join(", ");
  const { effort, webSearch } = defaultOptions();
  return (
    <AnswerView
      navigationTitle={`About ${FILE_MANAGER} Selection`}
      prompt={askAboutFilesPrompt(selection.paths, question)}
      question={`${question} (${shown})`}
      options={{ effort, webSearch, readDirs: selection.dirs }}
    />
  );
}

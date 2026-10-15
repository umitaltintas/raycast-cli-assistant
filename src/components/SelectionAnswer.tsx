import { Detail, Icon, List, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { RequestOptions } from "../lib/options";
import { readSourceText, SourceText } from "../lib/selection";
import { AnswerView } from "./AnswerView";

interface Props {
  buildPrompt: (text: string) => string;
  question: (source: SourceText) => string;
  systemPrompt?: string;
  navigationTitle: string;
  // How the answer starts, possibly depending on the text; its actions turn
  // options on or off and ask again.
  options?:
    RequestOptions | ((source: SourceText) => RequestOptions | undefined);
}

// Reads the selection and hands it to AnswerView; falls back to the clipboard.
export function SelectionAnswer(props: Props) {
  const [source, setSource] = useState<SourceText | null>();

  useEffect(() => {
    readSourceText({ allowClipboard: true }).then((s) => {
      setSource(s ?? null);
      if (s?.from === "clipboard") {
        showToast({
          style: Toast.Style.Success,
          title: "No selection, using clipboard text",
        });
      }
    });
  }, []);

  if (source === undefined) return <Detail isLoading markdown="" />;
  if (source === null) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Text}
          title="No Text Found"
          description="Select text in any app or copy it to the clipboard."
        />
      </List>
    );
  }
  return (
    <AnswerView
      prompt={props.buildPrompt(source.text)}
      question={props.question(source)}
      systemPrompt={props.systemPrompt}
      navigationTitle={props.navigationTitle}
      options={
        typeof props.options === "function"
          ? props.options(source)
          : props.options
      }
    />
  );
}

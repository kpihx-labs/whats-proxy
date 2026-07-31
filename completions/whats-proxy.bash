# whats-proxy bash completion (generated from the 65-action registry)
_whats_proxy() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  local actions="analytics-chat-insights analytics-overview analytics-search analytics-timeline analytics-top-chats batch-send-text channel-create channel-delete channel-info channel-manage channel-update chat-disappearing chat-list chat-manage chat-read chat-star connection-status contact-block contact-business contact-check contact-info contact-list contact-picture contact-tags daily-digest delete-message edit-message find-messages forward-message group-create group-description group-info group-invite group-leave group-list group-participants group-picture group-settings group-subject guide label-chat label-manage label-message media-cleanup media-download messages-multi presence profile-about profile-name profile-picture profile-privacy read-messages search-messages send-audio send-contact send-document send-image send-location send-poll send-reaction send-sticker send-text send-video watchlist whatsup"
  case "$prev" in
    do) COMPREPLY=( $(compgen -W "$actions" -- "$cur") ); return ;;
    admin) COMPREPLY=( $(compgen -W "setup status stop" -- "$cur") ); return ;;
  esac
  if [[ "$COMP_CWORD" -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "do admin --version --help" -- "$cur") )
  fi
}
complete -F _whats_proxy whats-proxy

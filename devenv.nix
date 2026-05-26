{ pkgs, ... }:

{
  packages = [
    pkgs.jq
    pkgs.unzip
    pkgs.curl
    pkgs.google-cloud-sdk
    pkgs.mark
  ];

  languages.javascript = {
    enable = true;
    npm.enable = true;
  };

  enterShell = ''
    export PD_BIN="$DEVENV_ROOT/.devenv/pd"
    export PATH="$PD_BIN:$PATH"
    if [ ! -x "$PD_BIN/pd" ]; then
      echo "Downloading Pipedream CLI..."
      mkdir -p "$PD_BIN"
      curl -fsSL https://cli.pipedream.com/linux/amd64/latest/pd.zip -o /tmp/pd.zip
      unzip -o /tmp/pd.zip -d "$PD_BIN"
      chmod +x "$PD_BIN/pd"
      rm /tmp/pd.zip
      echo "pd installed: $(pd --version)"
    fi
  '';
}

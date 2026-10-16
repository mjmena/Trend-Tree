{ pkgs, ... }:

{
  packages = [
    pkgs.jq
    pkgs.unzip
    pkgs.curl
    pkgs.google-cloud-sdk
    pkgs.mark
    pkgs.typescript-language-server
    pkgs.typescript
  ];

  languages.javascript = {
    enable = true;
    npm.enable = true;
  };
}

{
  "targets": [
    {
      "target_name": "raise_fd_limit",
      "sources": ["raise_fd_limit.c"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "11.0"
          }
        }]
      ]
    }
  ]
}

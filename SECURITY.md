# Security

Do not commit credentials, tokens, cookies, private keys, personal data, private repository details, or internal service endpoints to this repository.

If you discover sensitive information:

1. Do not open a public issue containing the value.
2. Revoke or rotate the affected credential immediately.
3. Contact the repository owner privately with the affected path and commit.
4. Treat removal from the latest revision as insufficient if the value exists in Git history.

The bundled shell scripts perform Git workflow checks only. They do not read credential files or transmit repository contents.
